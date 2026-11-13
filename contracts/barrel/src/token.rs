//! NEP-245 multi-token core. The token ID is the series ID.
//! Barrels in a wallet are freely transferable; Barrels in a tank are held
//! by the contract account and can only leave through `settle` or `withdraw`.

use crate::{events, near, require, AccountId, Contract, ContractExt, U128};
use near_sdk::{env, ext_contract, Gas, NearToken, Promise};

const GAS_ON_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_RESOLVE: Gas = Gas::from_tgas(15);

#[near(serializers = [json])]
pub struct Token {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

#[ext_contract(ext_mt_receiver)]
#[allow(dead_code)]
pub trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128>;
}

type Approval = Option<(AccountId, u64)>;

#[near]
impl Contract {
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Approval,
        memo: Option<String>,
    ) {
        require!(approval.is_none(), "approvals are not supported");
        self.transfer_many(&receiver_id, &[token_id], &[amount], memo.as_deref());
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Approval>>,
        memo: Option<String>,
    ) {
        require!(no_approvals(&approvals), "approvals are not supported");
        self.transfer_many(&receiver_id, &token_ids, &amounts, memo.as_deref());
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Approval,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(approval.is_none(), "approvals are not supported");
        self.transfer_call_many(receiver_id, vec![token_id], vec![amount], memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Approval>>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(no_approvals(&approvals), "approvals are not supported");
        self.transfer_call_many(receiver_id, token_ids, amounts, memo, msg)
    }

    /// Finishes a `mt_transfer_call`: returns whatever the receiver did not use.
    #[private]
    pub fn mt_resolve_transfer(
        &mut self,
        previous_owner_ids: Vec<AccountId>,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        #[allow(unused_variables)] approvals: Option<Vec<Option<Vec<(AccountId, u64)>>>>,
    ) -> Vec<U128> {
        // The receiver answers with one unused amount per token. A failed
        // call, an oversized answer or malformed JSON all count as "unused".
        let unused: Option<Vec<U128>> = env::promise_result_checked(0, 64 * (amounts.len() + 1))
            .ok()
            .and_then(|bytes| near_sdk::serde_json::from_slice(&bytes).ok());
        let mut transferred = Vec::with_capacity(amounts.len());
        for (i, token_id) in token_ids.iter().enumerate() {
            let series_id = parse_token_id(token_id);
            let sent = amounts[i].0;
            // A failed or malformed receiver response returns everything.
            let wanted_back = unused
                .as_ref()
                .and_then(|u| u.get(i))
                .map(|u| u.0.min(sent))
                .unwrap_or(sent);
            let back = wanted_back.min(self.balance_of(&receiver_id, series_id));
            if back > 0 {
                self.debit(&receiver_id, series_id, back);
                self.credit(&previous_owner_ids[i], series_id, back);
                events::mt_transfer(&receiver_id, &previous_owner_ids[i], series_id, back, Some("refund"));
            }
            transferred.push(U128(sent - back));
        }
        transferred
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|token_id| {
                token_id
                    .parse::<u64>()
                    .ok()
                    .filter(|id| self.series.get(id).is_some())
                    .map(|_| Token { token_id, owner_id: None })
            })
            .collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        let Ok(series_id) = token_id.parse::<u64>() else {
            return U128(0);
        };
        // The contract account holds whatever is locked in tanks.
        if account_id == env::current_account_id() {
            return self
                .series
                .get(&series_id)
                .map(|s| s.in_tanks)
                .unwrap_or(U128(0));
        }
        U128(self.balance_of(&account_id, series_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .into_iter()
            .map(|t| self.mt_balance_of(account_id.clone(), t))
            .collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        let series = self.series.get(&token_id.parse::<u64>().ok()?)?;
        Some(U128(series.minted.0 - series.burned.0 - series.refunded.0))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }
}

impl Contract {
    fn transfer_many(
        &mut self,
        receiver_id: &AccountId,
        token_ids: &[String],
        amounts: &[U128],
        memo: Option<&str>,
    ) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach exactly 1 yoctoNEAR"
        );
        require!(
            !token_ids.is_empty() && token_ids.len() == amounts.len(),
            "token_ids and amounts must match"
        );
        let sender = env::predecessor_account_id();
        require!(&sender != receiver_id, "sender and receiver are the same");
        require!(
            receiver_id != &env::current_account_id(),
            "use fill to move Barrels into a tank"
        );
        for (token_id, amount) in token_ids.iter().zip(amounts) {
            let series_id = parse_token_id(token_id);
            require!(self.series.get(&series_id).is_some(), "unknown token");
            require!(amount.0 > 0, "zero amount");
            self.debit(&sender, series_id, amount.0);
            self.credit(receiver_id, series_id, amount.0);
            events::mt_transfer(&sender, receiver_id, series_id, amount.0, memo);
        }
    }

    fn transfer_call_many(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        self.transfer_many(&receiver_id, &token_ids, &amounts, memo.as_deref());
        let sender = env::predecessor_account_id();
        let previous_owner_ids = vec![sender.clone(); token_ids.len()];
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_ON_TRANSFER)
            .with_unused_gas_weight(1)
            .mt_on_transfer(
                sender,
                previous_owner_ids.clone(),
                token_ids.clone(),
                amounts.clone(),
                msg,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .with_unused_gas_weight(0)
                    .mt_resolve_transfer(previous_owner_ids, receiver_id, token_ids, amounts, None),
            )
    }
}

fn no_approvals(approvals: &Option<Vec<Approval>>) -> bool {
    approvals
        .as_ref()
        .map(|list| list.iter().all(|a| a.is_none()))
        .unwrap_or(true)
}

fn parse_token_id(token_id: &str) -> u64 {
    token_id
        .parse::<u64>()
        .unwrap_or_else(|_| env::panic_str("token_id must be a series number"))
}
