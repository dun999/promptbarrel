//! Series: one operator, one grade, one price, one expiry.
//! Buying mints Barrels and holds the USDC in escrow. The operator is paid
//! only by `settle` (see tank.rs). After expiry, unused Barrels refund.

use crate::util::{now_sec, units_for, usdc_ceil, usdc_floor};
use crate::{
    events, near, require, AccountId, Contract, ContractExt, GAS_CALLBACK, RECORD_DEPOSIT, U128,
};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, is_promise_success, PromiseOrValue};

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Series {
    pub id: u64,
    pub operator: AccountId,
    pub grade_id: String,
    /// Where the operator's Pump is reachable.
    pub endpoint: String,
    /// USDC base units for one Barrel (1,000,000 units).
    pub price_per_barrel: U128,
    /// Unix seconds. No buying or filling after this.
    pub window_end: u64,
    pub cap_units: U128,
    pub minted: U128,
    /// Units delivered and settled against receipts.
    pub burned: U128,
    /// Units burned for their USDC outside settlement: refunds after expiry,
    /// and the leftover of an accepted job tank paid to its agent.
    pub refunded: U128,
    /// Units currently locked in tanks.
    pub in_tanks: U128,
    /// USDC buyers have paid into escrow.
    pub escrow_in: U128,
    /// USDC earned by the operator through settlements (cumulative).
    pub released: U128,
    /// USDC paid out for `refunded` units (cumulative).
    pub refund_paid: U128,
    /// Earned but not yet transferred to the operator.
    pub payable: U128,
}

#[near(serializers = [json])]
pub struct BuyMsg {
    pub series_id: u64,
    /// Who receives the Barrels. Defaults to the sender.
    pub to: Option<AccountId>,
}

#[near]
impl Contract {
    /// Anyone can open a series. An operator earns only against receipts
    /// under keys registered for the grade, so a fake operator can waste a
    /// buyer's time but cannot take the money.
    #[payable]
    pub fn open_series(
        &mut self,
        grade_id: String,
        endpoint: String,
        price_per_barrel: U128,
        window_end: u64,
        cap_units: U128,
    ) -> u64 {
        self.assert_live();
        require!(
            env::attached_deposit() >= RECORD_DEPOSIT,
            "attach 0.01 NEAR for storage"
        );
        require!(self.grades.get(&grade_id).is_some(), "unknown grade");
        require!(endpoint.len() <= 256, "endpoint too long");
        require!(price_per_barrel.0 > 0, "price must be positive");
        require!(window_end > now_sec(), "window already ended");
        require!(
            cap_units.0 > 0 && cap_units.0 <= self.config.max_series_units.0,
            "cap outside limits"
        );
        let id = self.next_series_id;
        self.next_series_id += 1;
        let series = Series {
            id,
            operator: env::predecessor_account_id(),
            grade_id,
            endpoint,
            price_per_barrel,
            window_end,
            cap_units,
            minted: U128(0),
            burned: U128(0),
            refunded: U128(0),
            in_tanks: U128(0),
            escrow_in: U128(0),
            released: U128(0),
            refund_paid: U128(0),
            payable: U128(0),
        };
        events::barrel("open_series", json!({ "series": &series }));
        self.series.insert(id, series);
        id
    }

    /// The operator moves its Pump. The endpoint only says where to ask:
    /// payment still needs the model's signature, so a wrong address can
    /// waste a buyer's time but cannot take the money.
    pub fn set_series_endpoint(&mut self, series_id: u64, endpoint: String) {
        require!(endpoint.len() <= 256, "endpoint too long");
        let series = self
            .series
            .get_mut(&series_id)
            .unwrap_or_else(|| env::panic_str("unknown series"));
        require!(
            env::predecessor_account_id() == series.operator,
            "series operator only"
        );
        series.endpoint = endpoint.clone();
        events::barrel("set_series_endpoint", json!({ "series_id": series_id, "endpoint": endpoint }));
    }

    /// Buy: `usdc.ft_transfer_call(barrel, amount, msg = {"series_id": N})`.
    /// Returns the USDC that was not used, which the token contract refunds.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.config.usdc,
            "only the configured USDC token is accepted"
        );
        self.assert_live();
        let buy: BuyMsg = serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("msg must be {\"series_id\": <number>}"));
        let mut series = self
            .series
            .get(&buy.series_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown series"));
        require!(now_sec() < series.window_end, "series expired");

        let price = series.price_per_barrel.0;
        let room = series.cap_units.0 - series.minted.0;
        let units = units_for(amount.0, price).min(room);
        require!(units > 0, "amount too small or series sold out");
        let cost = usdc_ceil(units, price);
        require!(cost <= amount.0, "rounding error");
        require!(
            self.total_escrow + cost <= self.config.max_total_escrow.0,
            "global escrow cap reached"
        );

        let to = buy.to.unwrap_or(sender_id.clone());
        series.minted.0 += units;
        series.escrow_in.0 += cost;
        self.total_escrow += cost;
        self.series.insert(series.id, series.clone());
        self.credit(&to, series.id, units);

        events::mt_mint(&to, series.id, units);
        events::barrel(
            "buy",
            json!({ "series_id": series.id, "buyer": sender_id, "to": to,
                    "units": U128(units), "usdc": U128(cost) }),
        );
        PromiseOrValue::Value(U128(amount.0 - cost))
    }

    /// When refunds open for a series, in Unix seconds.
    pub fn refund_opens_at(&self, series_id: u64) -> u64 {
        let series = self
            .series
            .get(&series_id)
            .unwrap_or_else(|| env::panic_str("unknown series"));
        series.window_end + self.config.settle_grace_sec
    }

    /// After expiry: burn unused Barrels for the USDC that backed them.
    pub fn refund(&mut self, series_id: u64, units: U128) -> PromiseOrValue<U128> {
        let account = env::predecessor_account_id();
        let mut series = self
            .series
            .get(&series_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown series"));
        require!(
            now_sec() >= series.window_end + self.config.settle_grace_sec,
            "refunds open after the series expires"
        );
        require!(units.0 > 0, "nothing to refund");
        self.debit(&account, series_id, units.0);

        let price = series.price_per_barrel.0;
        let before = usdc_floor(series.refunded.0, price);
        series.refunded.0 += units.0;
        let amount = usdc_floor(series.refunded.0, price) - before;
        series.refund_paid.0 += amount;
        self.series.insert(series_id, series);

        events::mt_burn(&account, series_id, units.0, "refund");
        events::barrel(
            "refund",
            json!({ "series_id": series_id, "account": account, "units": units, "usdc": U128(amount) }),
        );
        if amount == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        PromiseOrValue::Promise(
            self.send_usdc(&account, amount).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_refund(account, series_id, units, U128(amount)),
            ),
        )
    }

    #[private]
    pub fn on_refund(
        &mut self,
        account: AccountId,
        series_id: u64,
        units: U128,
        amount: U128,
    ) -> U128 {
        if is_promise_success() {
            return amount;
        }
        // The USDC transfer failed (for example the holder is not registered
        // with the token). Put everything back so they can try again.
        let mut series = self.series.get(&series_id).cloned().unwrap();
        series.refunded.0 -= units.0;
        series.refund_paid.0 -= amount.0;
        self.series.insert(series_id, series);
        self.total_escrow += amount.0;
        self.credit(&account, series_id, units.0);
        events::mt_mint(&account, series_id, units.0);
        events::barrel(
            "refund_failed",
            json!({ "series_id": series_id, "account": account, "units": units }),
        );
        U128(0)
    }

    /// Sends the operator whatever settlements have earned so far.
    /// `settle` calls this itself; it is public so a failed payout can be retried.
    pub fn claim(&mut self, series_id: u64) -> PromiseOrValue<U128> {
        match self.pay_operator(series_id) {
            Some(p) => PromiseOrValue::Promise(p),
            None => PromiseOrValue::Value(U128(0)),
        }
    }

    #[private]
    pub fn on_payout(&mut self, series_id: u64, amount: U128) -> U128 {
        if is_promise_success() {
            return amount;
        }
        let mut series = self.series.get(&series_id).cloned().unwrap();
        series.payable.0 += amount.0;
        self.series.insert(series_id, series);
        self.total_escrow += amount.0;
        events::barrel(
            "payout_failed",
            json!({ "series_id": series_id, "usdc": amount }),
        );
        U128(0)
    }

    pub fn get_series(&self, series_id: u64) -> Option<Series> {
        self.series.get(&series_id).cloned()
    }

    pub fn get_series_list(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Series> {
        self.series
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }
}

impl Contract {
    pub(crate) fn pay_operator(&mut self, series_id: u64) -> Option<near_sdk::Promise> {
        let mut series = self
            .series
            .get(&series_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown series"));
        let amount = series.payable.0;
        if amount == 0 {
            return None;
        }
        series.payable.0 = 0;
        let operator = series.operator.clone();
        self.series.insert(series_id, series);
        Some(
            self.send_usdc(&operator, amount).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_payout(series_id, U128(amount)),
            ),
        )
    }
}
