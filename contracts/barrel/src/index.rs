//! The delivery price index: what a Barrel of each grade actually cost over
//! the last 24 hours, counted only from answers that were proven and paid.
//! Nothing can be added to it without a model signature the contract
//! verified, so it cannot be painted with wash trades.

use crate::util::{now_sec, UNITS_PER_BARREL};
use crate::{near, Contract, ContractExt, U128};

const HOURS: u64 = 24;

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Bucket {
    /// Unix time divided by 3600.
    pub hour: u64,
    pub units: U128,
    /// Sum of units x price per Barrel, so the average is exact.
    pub value: U128,
    pub deliveries: u32,
}

#[near(serializers = [json])]
pub struct IndexView {
    pub grade_id: String,
    /// Volume-weighted USDC base units per Barrel. Zero when nothing settled.
    pub price_per_barrel: U128,
    pub units: U128,
    /// USDC base units paid for those units.
    pub usdc: U128,
    pub deliveries: u32,
    pub window_sec: u64,
    pub buckets: Vec<Bucket>,
}

#[near]
impl Contract {
    pub fn get_index(&self, grade_id: String) -> IndexView {
        let oldest = (now_sec() / 3600).saturating_sub(HOURS - 1);
        let buckets: Vec<Bucket> = self
            .index
            .get(&grade_id)
            .map(|b| b.iter().filter(|b| b.hour >= oldest).cloned().collect())
            .unwrap_or_default();
        let units: u128 = buckets.iter().map(|b| b.units.0).sum();
        let value: u128 = buckets.iter().map(|b| b.value.0).sum();
        IndexView {
            grade_id,
            price_per_barrel: U128(if units == 0 { 0 } else { value / units }),
            units: U128(units),
            usdc: U128(value / UNITS_PER_BARREL),
            deliveries: buckets.iter().map(|b| b.deliveries).sum(),
            window_sec: HOURS * 3600,
            buckets,
        }
    }
}

impl Contract {
    /// Called by every path that pays an operator for proven units.
    pub(crate) fn record_delivery(&mut self, grade_id: &str, units: u128, price: u128, deliveries: u32) {
        if units == 0 {
            return;
        }
        let hour = now_sec() / 3600;
        let oldest = hour.saturating_sub(HOURS - 1);
        let mut buckets = self.index.get(grade_id).cloned().unwrap_or_default();
        buckets.retain(|b| b.hour >= oldest);
        match buckets.iter_mut().find(|b| b.hour == hour) {
            Some(b) => {
                b.units.0 += units;
                b.value.0 += units * price;
                b.deliveries += deliveries;
            }
            None => buckets.push(Bucket {
                hour,
                units: U128(units),
                value: U128(units * price),
                deliveries,
            }),
        }
        self.index.insert(grade_id.to_string(), buckets);
    }
}
