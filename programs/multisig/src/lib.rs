use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

mod wrapped_sol {
    use super::*;
    declare_id!("So11111111111111111111111111111111111111112");
}

declare_id!("9EHUwkYdtit9iyJYRZkz956cPYfqHgGaaHwqhscir4F9");

#[error_code]
pub enum ErrorCode {
    #[msg("Owners must be unique")]
    UniqueOwners,
    #[msg("Threshold must be less than or equal to the number of owners.")]
    InvalidThreshold,
    #[msg("Owners length must be non zero and less than or equal to 20.")]
    InvalidOwnersLen,
    #[msg("Insufficient lamports balance.")]
    InsufficientLamports,
    #[msg("Invalid mint address.")]
    InvalidMint,
    #[msg("Insufficient token balance.")]
    InvalidTokenAmount,
    #[msg("Invalid creator token account.")]
    InvalidVault,
    #[msg("Invalid signer.")]
    InvalidSigner,
    #[msg("Insufficient signers.")]
    InsufficientApprovers,
    #[msg("Invalid token account.")]
    InvalidTokenAccount,
    #[msg("Invalid multisig bump")]
    InvalidMultisigBump,
    #[msg("Invalid transaction bump")]
    InvalidTransactionBump,
    #[msg("Invalid expire time.")]
    InvalidExpire,
    #[msg("Do not duplicate signatures.")]
    DuplicateSignature,
    #[msg("Can not cancel approved transaction.")]
    CantCancel,
}

#[program]
pub mod multisig {

    use super::*;

    pub fn initialize_user(ctx: Context<InitializeUser>) -> Result<()> {
        let user = &mut ctx.accounts.user;

        user.count = 0;
        msg!("Initialized user account");
        Ok(())
    }

    pub fn initialize_multisig(
        ctx: Context<InitializeMultisig>,
        owners: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        assert_unique_owners(&owners)?;
        require!(
            threshold > 0 && threshold <= owners.len() as u8,
            InvalidThreshold
        );
        require!(owners.len() > 0 && owners.len() <= 20, InvalidOwnersLen);

        let multisig_account = &mut ctx.accounts.multisig_account;
        multisig_account.creator = ctx.accounts.creator.key();
        multisig_account.owners = owners;
        multisig_account.threshold = threshold;

        let user = &mut ctx.accounts.user;
        multisig_account.id = user.count;
        user.count += 1;
        msg!("Current count: {}", user.count);

        msg!("Initialized Multisig Account");

        emit!(InitializeMultisigEvent {
            creator: ctx.accounts.creator.key(),
            multisig: multisig_account.key(),
            time: ctx.accounts.clock.unix_timestamp,
            label: "initialize_multisig".to_string(),
        });

        Ok(())
    }

    pub fn deposit<'info>(
        ctx: Context<'_, '_, '_, 'info, Deposit<'info>>,
        amount: u64,
    ) -> Result<()> {
        if ctx.remaining_accounts.is_empty() {
            require!(
                ctx.accounts.payer.lamports() >= amount,
                InsufficientLamports
            );

            let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.payer.key(),
                &ctx.accounts.multisig_account.key(),
                amount,
            );
            anchor_lang::solana_program::program::invoke_signed(
                &transfer_ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.multisig_account.to_account_info(),
                ],
                &[],
            )?;

            emit!(DepositLamportsEvent {
                payer: ctx.accounts.payer.key(),
                multisig: ctx.accounts.multisig_account.key(),
                amount,
                time: ctx.accounts.clock.unix_timestamp,
                label: "deposit_lamports".to_string(),
            });
            msg!("Deposit Lmaports Success {}", amount);
        } else {
            let mut accounts_iter = ctx.remaining_accounts.iter();
            let mint_account_info = next_account_info(&mut accounts_iter)?;
            let token_account_info = next_account_info(&mut accounts_iter)?;
            let vault_account_info = next_account_info(&mut accounts_iter)?;

            let token_account =
                TokenAccount::try_deserialize(&mut &token_account_info.data.borrow_mut()[..])?;
            let vault_account =
                TokenAccount::try_deserialize(&mut &vault_account_info.data.borrow_mut()[..])?;

            require!(token_account.mint == mint_account_info.key(), InvalidMint);
            require!(token_account.amount >= amount, InvalidTokenAmount);
            require!(
                vault_account.owner == ctx.accounts.multisig_account.key(),
                InvalidVault
            );

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: token_account_info.clone(),
                        to: vault_account_info.clone(),
                        authority: ctx.accounts.payer.to_account_info(),
                    },
                ),
                amount,
            )?;

            emit!(DepositTokenEvent {
                payer: ctx.accounts.payer.key(),
                mint: mint_account_info.key(),
                amount: amount,
                time: ctx.accounts.clock.unix_timestamp,
                label: "deposit_token".to_string(),
            });
            msg!("Deposit Token Success {}", amount);
        }

        msg!("Deposit Success");
        Ok(())
    }

    pub fn create_transaction<'info>(
        ctx: Context<'_, '_, '_, 'info, CreateTransaction<'info>>,
        amount: u64,
        expire: i64,
    ) -> Result<()> {
        let multisig_account = &mut ctx.accounts.multisig_account;

        let transaction_account = &mut ctx.accounts.transaction_account;
        transaction_account.multisig = multisig_account.key();
        transaction_account.creator = *ctx.accounts.creator.key;
        transaction_account.receiver = *ctx.accounts.receiver.key;
        transaction_account.amount = amount;
        transaction_account.tx_count = multisig_account.tx_count;
        transaction_account.owners = multisig_account.owners.clone();
        transaction_account.threshold = multisig_account.threshold;
        transaction_account.is_executed = false;
        transaction_account.signs = vec![false; transaction_account.owners.len()];
        transaction_account.approve(ctx.accounts.creator.key)?;
        transaction_account.mint = ctx.accounts.mint.key();
        transaction_account.ttype = if ctx.accounts.mint.key() == wrapped_sol::ID {
            TransactionType::Lamports
        } else {
            TransactionType::Token
        };

        if expire < 0 {
            return err!(InvalidExpire);
        }
        transaction_account.expire_at = expire;
        transaction_account.status = TransactionStatus::Active;

        multisig_account.tx_count += 1;

        msg!(
            "Succeeded create transaction account: {}",
            ctx.accounts.transaction_account.key().to_string()
        );

        emit!(CreateTransactionEvent {
            creator: ctx.accounts.creator.key(),
            transaction_account: ctx.accounts.transaction_account.key(),
            amount,
            expire,
            time: ctx.accounts.clock.unix_timestamp,
            label: "approve_transaction".to_string(),
        });
        Ok(())
    }

    pub fn approve_transaction(ctx: Context<ApproveTransaction>) -> Result<()> {
        let transaction_account = &mut ctx.accounts.transaction_account;

        transaction_account.timeout(ctx.accounts.clock.unix_timestamp)?;

        if transaction_account.status == TransactionStatus::Active {
            transaction_account.approve(ctx.accounts.payer.key)?;
            if transaction_account.is_approved() {
                transaction_account.status = TransactionStatus::Approved;
            }
        }

        emit!(ApproveTransactionEvent {
            user: ctx.accounts.payer.key(),
            transaction_account: ctx.accounts.transaction_account.key(),
            time: ctx.accounts.clock.unix_timestamp,
            label: "approve_transaction".to_string(),
        });

        msg!("Succeeded approve transaction");
        Ok(())
    }

    pub fn cancel_transaction(ctx: Context<CancelTransaction>) -> Result<()> {
        let transaction_account = &mut ctx.accounts.transaction_account;

        if transaction_account.status == TransactionStatus::Approved {
            return err!(CantCancel);
        }
        transaction_account.status = TransactionStatus::Canceled;

        emit!(CancelTransactionEvent {
            user: ctx.accounts.creator.key(),
            transaction_account: ctx.accounts.transaction_account.key(),
            time: ctx.accounts.clock.unix_timestamp,
            label: "cancel_transaction".to_string(),
        });
        msg!("Succeeded cancel transaction");
        Ok(())
    }

    pub fn execute_transaction<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteTransaction<'info>>,
    ) -> Result<()> {
        let multisig_account = &ctx.accounts.multisig_account;
        let transaction_account = &mut ctx.accounts.transaction_account;

        if transaction_account.status != TransactionStatus::Approved {
            return err!(InsufficientApprovers);
        }

        if !transaction_account
            .owners
            .iter()
            .any(|b| *b == ctx.accounts.payer.key())
        {
            return err!(InvalidSigner);
        }

        transaction_account.is_executed = true;
        transaction_account.status = TransactionStatus::Completed;
        let amount = transaction_account.amount;
        match transaction_account.ttype {
            TransactionType::Lamports => {
                **ctx
                    .accounts
                    .multisig_account
                    .to_account_info()
                    .try_borrow_mut_lamports()? -= amount;
                **ctx
                    .accounts
                    .receiver
                    .to_account_info()
                    .try_borrow_mut_lamports()? += amount;

                msg!("exec transaction lamports success {}", amount);
            }
            TransactionType::Token => {
                msg!("token transfer");
                let mut accounts_iter = ctx.remaining_accounts.iter();
                let mint_account_info = next_account_info(&mut accounts_iter)?;
                let vault_account_info = next_account_info(&mut accounts_iter)?;
                let token_account_info = next_account_info(&mut accounts_iter)?;

                let vault =
                    TokenAccount::try_deserialize(&mut &vault_account_info.data.borrow_mut()[..])?;
                let token =
                    TokenAccount::try_deserialize(&mut &token_account_info.data.borrow_mut()[..])?;

                require!(
                    transaction_account.mint == mint_account_info.key(),
                    InvalidMint
                );
                require!(token.mint == mint_account_info.key(), InvalidMint);
                require!(vault.mint == mint_account_info.key(), InvalidMint);

                require!(vault.owner == multisig_account.key(), InvalidVault);
                require!(
                    token.owner == transaction_account.receiver,
                    InvalidTokenAccount
                );

                let multisig_creator_key = multisig_account.creator;
                let multisig_id = multisig_account.id;
                let amount = transaction_account.amount;
                let seeds = &[
                    multisig_creator_key.as_ref(),
                    &multisig_id.to_le_bytes()[..],
                    Multisig::SEEDS,
                    &[*ctx
                        .bumps
                        .get("multisig_account")
                        .ok_or(ErrorCode::InvalidMultisigBump)?],
                ];
                let signer = &[&seeds[..]];
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: vault_account_info.clone(),
                            to: token_account_info.clone(),
                            authority: ctx.accounts.multisig_account.to_account_info(),
                        },
                        signer,
                    ),
                    amount,
                )?;

                msg!("exec transaction token success {}", amount);
            }
        }
        Ok(())
    }
}

fn assert_unique_owners(owners: &[Pubkey]) -> Result<()> {
    for (i, owner) in owners.iter().enumerate() {
        require!(
            !owners.iter().skip(i + 1).any(|item| item == owner),
            UniqueOwners
        )
    }
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeUser<'info> {
    #[account(mut)]
    pub creator: Signer<'info>, 

    #[account(init,
        seeds = [creator.key().as_ref(), User::SEEDS],
        bump,
        payer = creator,
        space = 8 + 8,
    )]
    pub user: Account<'info, User>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeMultisig<'info> {
    #[account(mut)]
    pub creator: Signer<'info>, 
    #[account(mut)]
    pub user: Account<'info, User>,

    #[account(init,
        seeds = [creator.key().as_ref(), user.count.to_le_bytes().as_ref(), Multisig::SEEDS],
        bump,
        payer = creator,
        space = 8 + Multisig::LEN,
    )]
    pub multisig_account: Account<'info, Multisig>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>, 
    #[account(mut)]
    pub multisig_account: Account<'info, Multisig>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
    // pub mint: UncheckedAccount<'info>,
    // pub token: UncheckedAccount<'info>,
    // pub vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreateTransaction<'info> {
    #[account(mut)]
    pub creator: Signer<'info>, 

    /// CHECK:
    pub receiver: UncheckedAccount<'info>,

    #[account(mut)]
    pub multisig_account: Account<'info, Multisig>,

    // Token token mint
    pub mint: Account<'info, Mint>,

    #[account(init,
        seeds = [multisig_account.key().as_ref(), multisig_account.tx_count.to_le_bytes().as_ref(), Transaction::SEEDS],
        bump,
        payer = creator,
        space = 8 + Transaction::LEN,
    )]
    pub transaction_account: Account<'info, Transaction>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
    // pub mint: UncheckedAccount<'info>,
    // pub token: UncheckedAccount<'info>,
    // pub vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ApproveTransaction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>, 

    #[account(mut)]
    pub transaction_account: Account<'info, Transaction>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct CancelTransaction<'info> {
    #[account(mut)]
    pub creator: Signer<'info>, 

    #[account(mut,
        constraint = creator.key() == transaction_account.creator,
    )]
    pub transaction_account: Account<'info, Transaction>,

    pub clock: Sysvar<'info, Clock>,
}

#[derive(Accounts)]
pub struct ExecuteTransaction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK:
    #[account(mut)]
    pub receiver: UncheckedAccount<'info>,

    #[account(mut,
        seeds = [multisig_account.creator.key().as_ref(), multisig_account.id.to_le_bytes().as_ref(), Multisig::SEEDS],
        bump,
    )]
    pub multisig_account: Account<'info, Multisig>,

    #[account(mut,
        constraint = receiver.key() == transaction_account.receiver,
    )]
    pub transaction_account: Account<'info, Transaction>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
    // for token transfer
    // pub mint:  UncheckedAccount<'info>,
    // pub vault: UncheckedAccount<'info>,
    // pub token: UncheckedAccount<'info>,
}

#[account]
pub struct User {
    pub count: u64,
}
impl User {
    pub const SEEDS: &'static [u8] = b"user";
}

#[account]
pub struct Multisig {
    pub creator: Pubkey,
    pub owners: Vec<Pubkey>,
    pub threshold: u8,
    pub id: u64,
    pub tx_count: u64,
}

impl Multisig {
    pub const SEEDS: &'static [u8] = b"multisig";
    pub const LEN: usize = 32 + 20 * 32 + 1 + 8;
}

#[derive(Debug, Clone, Copy, AnchorDeserialize, AnchorSerialize)]
pub enum TransactionType {
    Token,
    Lamports,
}

#[derive(Debug, Clone, Copy, PartialEq, AnchorDeserialize, AnchorSerialize)]
pub enum TransactionStatus {
    Active,
    Timeout,
    Approved,
    Completed,
    Canceled,
}

#[account]
pub struct Transaction {
    pub multisig: Pubkey,

    pub receiver: Pubkey,

    pub mint: Pubkey,

    pub is_executed: bool,

    pub ttype: TransactionType,

    pub amount: u64,

    pub tx_count: u64,

    pub owners: Vec<Pubkey>,
    pub signs: Vec<bool>,
    pub threshold: u8,

    pub expire_at: i64,

    pub status: TransactionStatus,

    pub creator: Pubkey,
}

impl Transaction {
    pub const SEEDS: &'static [u8] = b"transaction";
    pub const LEN: usize = 32 + 32 + 32 + 1 + 1 + 8 + 8 + 20 * 32 + 20 + 1 + 8 + 1 + 32;

    pub fn timeout(&mut self, now: i64) -> Result<()> {
        if self.status == TransactionStatus::Active && self.expire_at > 0 && self.expire_at <= now {
            self.status = TransactionStatus::Timeout;
        }
        Ok(())
    }

    pub fn approve(&mut self, signer: &Pubkey) -> Result<()> {
        let pos = self
            .owners
            .iter()
            .position(|owner| owner == signer)
            .ok_or(ErrorCode::InvalidSigner)?;
        if self.signs[pos] {
            return err!(DuplicateSignature);
        }
        self.signs[pos] = true;
        Ok(())
    }

    pub fn is_approved(&self) -> bool {
        self.signs.iter().filter(|b| **b).count() >= self.threshold as usize
    }
}

#[event]
pub struct InitializeMultisigEvent {
    creator: Pubkey,
    multisig: Pubkey,
    time: i64,
    #[index]
    label: String,
}

#[event]
pub struct DepositLamportsEvent {
    payer: Pubkey,
    multisig: Pubkey,
    amount: u64,
    time: i64,
    #[index]
    label: String,
}

#[event]
pub struct DepositTokenEvent {
    payer: Pubkey,
    mint: Pubkey,
    amount: u64,
    time: i64,
    #[index]
    label: String,
}

#[event]
pub struct CreateTransactionEvent {
    creator: Pubkey,
    transaction_account: Pubkey,
    amount: u64,
    expire: i64,
    time: i64,
    #[index]
    label: String,
}

#[event]
pub struct ApproveTransactionEvent {
    user: Pubkey,
    transaction_account: Pubkey,
    time: i64,
    #[index]
    label: String,
}

#[event]
pub struct CancelTransactionEvent {
    user: Pubkey,
    transaction_account: Pubkey,
    time: i64,
    #[index]
    label: String,
}

#[event]
pub struct ExecuteTransactionEvent {
    user: Pubkey,
    mint: Pubkey,
    amount: u64,
    time: i64,
    #[index]
    label: String,
}
