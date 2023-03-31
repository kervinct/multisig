import * as anchor from '@project-serum/anchor';
import { Program } from '@project-serum/anchor';
import * as spl from "@solana/spl-token";
import NodeWallet from "@project-serum/anchor/dist/cjs/nodewallet";
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { nu64 } from 'buffer-layout';
import { assert } from 'chai';
import { Multisig } from "../target/types/multisig";
import { publicKey, rpc } from '@project-serum/anchor/dist/cjs/utils';

const print = console.log;
const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;
const WSOL = 'So11111111111111111111111111111111111111112';
const expireTime = 1661568007;

describe("multisig sol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Multisig as Program<Multisig>;

  const creator = anchor.web3.Keypair.generate();

  const owner1 = anchor.web3.Keypair.generate();
  const owner2 = anchor.web3.Keypair.generate();
  const owner3 = anchor.web3.Keypair.generate();
  const owner4 = anchor.web3.Keypair.generate();
  const receiver = anchor.web3.Keypair.generate();


  let userAccount;
  let multisigAccount;
  let transactionAccount;

  it('airdrop sol', async () => {
    await provider.connection.requestAirdrop(
      creator.publicKey,
      1000 * LAMPORTS_PER_SOL,
    );

    await provider.connection.requestAirdrop(
      owner1.publicKey,
      10 * LAMPORTS_PER_SOL,
    );

    await provider.connection.requestAirdrop(
      owner2.publicKey,
      10 * LAMPORTS_PER_SOL,
    );

    await provider.connection.requestAirdrop(
      owner3.publicKey,
      10 * LAMPORTS_PER_SOL,
    );

    await provider.connection.requestAirdrop(
      owner4.publicKey,
      10 * LAMPORTS_PER_SOL,
    );

    await provider.connection.requestAirdrop(
      receiver.publicKey,
      100 * LAMPORTS_PER_SOL,
    );
  });

  it('initialize user', async () => {

    const [userAccountPk] = await anchor.web3.PublicKey.findProgramAddress(
      [
        creator.publicKey.toBuffer(),
        Buffer.from('user'),
      ],
      program.programId,
    );
    userAccount = userAccountPk;

    await program
      .methods
      .initializeUser()
      .accounts(
        {
          creator: creator.publicKey,
          user: userAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
        }
      )
      .signers([creator])
      .rpc({ skipPreflight: true });

    // const tx = new anchor.web3.Transaction();

    // tx.add(
    //   await program
    //     .methods
    //     .initializeUser()
    //     .accounts(
    //       {
    //         creator: creator.publicKey, 
    //         user: userAccount,
    //         systemProgram: anchor.web3.SystemProgram.programId,
    //       }
    //     )
    //     .instruction()
    // );

    // await provider.sendAndConfirm(tx, [creator], {skipPreflight: true});

    print(`userAccount: ${userAccount}`);
  });

  it('initialize multisig', async () => {
    const userAccountData = await program.account.user.fetch(userAccount);
    const buffer = Buffer.alloc(8);
    nu64().encode(userAccountData.count, buffer);

    const [multisigAccountPk] = await anchor.web3.PublicKey.findProgramAddress(
      [
        creator.publicKey.toBuffer(),
        buffer,
        Buffer.from('multisig'),
      ],
      program.programId,
    );

    multisigAccount = multisigAccountPk;
    print(`multisigAccount: ${multisigAccount}`);

    await program
      .methods
      .initializeMultisig(
        [creator.publicKey, owner1.publicKey, owner2.publicKey, owner3.publicKey],
        3
      )
      .accounts(
        {
          creator: creator.publicKey,
          user: userAccount,
          multisigAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY
        },
      )
      .signers([creator])
      .rpc();

    let multisigAccountData = await program.account.multisig.fetch(multisigAccount);

    print(`multisigAccountData: ${JSON.stringify(multisigAccountData)}`);
    assert.strictEqual(multisigAccountData.threshold, 3);
    assert.strictEqual(multisigAccountData.id.toNumber(), 0);
    assert.strictEqual(multisigAccountData.txCount.toNumber(), 0);
  });

  it('deposit', async () => {
    const buffer1 = Buffer.alloc(8)
    const depositAmount = new anchor.BN(100)

    const beforeCreator = await provider.connection.getAccountInfo(creator.publicKey);
    print(`beforeCreator: ${beforeCreator.lamports}`);

    await program
      .methods
      .deposit(depositAmount)
      .accounts({
        payer: creator.publicKey,
        multisigAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY
      })
      .signers([creator])
      .rpc({ skipPreflight: true })

    const afterCreator = await provider.connection.getAccountInfo(creator.publicKey);
    print(`afterCreator lamports: ${afterCreator.lamports}`);
    const msAccount = await provider.connection.getAccountInfo(multisigAccount);
    print(`msAccount lamports: ${msAccount.lamports}`);
  });

  it('create transaction', async () => {

    const mintPk = new anchor.web3.PublicKey(WSOL)
    const buffer2 = Buffer.alloc(8);
    nu64().encode(multisigAccount.txCount, buffer2);
    const [transactionAccountPk] = await anchor.web3.PublicKey.findProgramAddress(
      [
        multisigAccount.toBuffer(),
        buffer2,
        Buffer.from('transaction'),
      ],
      program.programId,
    );

    transactionAccount = transactionAccountPk;
    print(`transactionAccountPk ${transactionAccountPk}`);

    const txAmount = new anchor.BN(100)
    const expire = new anchor.BN(expireTime)

    await program
      .methods
      .createTransaction(txAmount, expire)
      .accounts({
        creator: creator.publicKey,
        receiver: receiver.publicKey,
        multisigAccount,
        mint: mintPk,
        transactionAccount: transactionAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
      })
      .signers([creator])
      .rpc({ skipPreflight: true })

    let transactionAccountData = await program.account.transaction.fetch(transactionAccount);

    print(`transactionAccountData: ${JSON.stringify(transactionAccountData)}`);

    assert.strictEqual(transactionAccountData.isExecuted, false);
    assert.strictEqual(transactionAccountData.amount.toNumber(), 100);
    assert.strictEqual(transactionAccountData.txCount.toNumber(), 0);
    assert.strictEqual(transactionAccountData.threshold, 3);
    assert.strictEqual(transactionAccountData.expireAt.toNumber(), expireTime);
  });


  it('approve transaction', async () => {
    let transactionAccountData = await program.account.transaction.fetch(transactionAccount);

    print(`transaction owners: ${transactionAccountData.owners}`);
    print(`transaction signs: ${transactionAccountData.signs}`);

    await program
      .methods
      .approveTransaction()
      .accounts(
        {
          payer: owner1.publicKey,
          transactionAccount,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      ).signers([owner1])
      .rpc();

    transactionAccountData = await program.account.transaction.fetch(transactionAccount);

    print(`transaction owners: ${transactionAccountData.owners}`);
    print(`transaction signs: ${transactionAccountData.signs}`);

    await program
      .methods
      .approveTransaction()
      .accounts(
        {
          payer: owner2.publicKey,
          transactionAccount,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        }
      ).signers([owner2])
      .rpc();

    transactionAccountData = await program.account.transaction.fetch(transactionAccount);

    print(`transaction owners: ${transactionAccountData.owners}`);
    print(`transaction signs: ${transactionAccountData.signs}`);

  });

  // it('cancel transaction', async () => {
  //   let transactionAccountData = await program.account.transaction.fetch(transactionAccount);

  //   print(`transaction owners: ${transactionAccountData.owners}`);
  //   print(`transaction signs: ${transactionAccountData.signs}`);

  //   await program
  //     .methods
  //     .cancelTransaction()
  //     .accounts(
  //       {
  //         creator: creator.publicKey,
  //         transactionAccount,
  //         clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
  //       }
  //     ).signers([creator])
  //     .rpc();

  //   transactionAccountData = await program.account.transaction.fetch(transactionAccount);

  //   print(`transaction owners: ${transactionAccountData.owners}`);
  //   print(`transaction signs: ${transactionAccountData.signs}`);

  // });

  it('execute transaction', async () => {

    const beforeTransactionAccount = await provider.connection.getAccountInfo(transactionAccount);
    print(`beforeTransactionAccount lamports: ${beforeTransactionAccount.lamports}`);

    const beforeReceiver = await provider.connection.getAccountInfo(receiver.publicKey);
    print(`beforeReceiver lamports: ${beforeReceiver.lamports}`);

    const multisigAccountData = await program.account.multisig.fetch(multisigAccount);
    print(`multisigAccountData id: ${multisigAccountData.id}`);
    print(`creator: ${creator.publicKey}`);
    print(`multisigAccountData creator: ${multisigAccountData.creator}`);

    await program
      .methods
      .executeTransaction()
      .accounts(
        {
          payer: owner2.publicKey,
          receiver: receiver.publicKey,
          multisigAccount,
          transactionAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          clock: anchor.web3.SYSVAR_CLOCK_PUBKEY,
        },
      )
      .signers([owner2])
      .rpc({ skipPreflight: true });

    const afterTransactionAccount = await provider.connection.getAccountInfo(transactionAccount);
    print(`afterTransactionAccount lamports: ${afterTransactionAccount.lamports}`);
    const afterReceiver = await provider.connection.getAccountInfo(receiver.publicKey);
    print(`afterReceiver lamports: ${afterReceiver.lamports}`);
  });

});

/*
describe("multisig token", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Multisig as Program<Multisig>;

  const creator = anchor.web3.Keypair.generate();
  const owner1 = anchor.web3.Keypair.generate();
  const owner2 = anchor.web3.Keypair.generate();
  const owner3 = anchor.web3.Keypair.generate();
  const receiver = anchor.web3.Keypair.generate();

  const mint = anchor.web3.Keypair.generate();
  let creatorTokenAccount;
  let vaultTokenAccount;
  let receiverTokenAccount;

  let userAccount;
  let multisigAccount;
  let transactionAccount;

  it('airdrop token', async () => {

    await provider.connection.requestAirdrop(
      creator.publicKey,
      1000 * LAMPORTS_PER_SOL,
    );
    await provider.connection.requestAirdrop(
      owner1.publicKey,
      10 * LAMPORTS_PER_SOL,
    );

    await provider.connection.requestAirdrop(
      owner2.publicKey,
      10 * LAMPORTS_PER_SOL,
    );

    await provider.connection.requestAirdrop(
      owner3.publicKey,
      10 * LAMPORTS_PER_SOL,
    );

    await provider.connection.requestAirdrop(
      receiver.publicKey,
      100 * LAMPORTS_PER_SOL,
    );


    await spl.createMint(
      provider.connection,
      creator,
      creator.publicKey,
      creator.publicKey,
      6,
      mint,
      { commitment: 'confirmed', skipPreflight: true },
    );

    print(`createAccount`);
    creatorTokenAccount = await spl.createAssociatedTokenAccount(
      provider.connection,
      creator,
      mint.publicKey,
      creator.publicKey,
      { commitment: 'confirmed' }
    );

    print(`create receiverTokenAccount`);
    receiverTokenAccount = await spl.createAssociatedTokenAccount(
      provider.connection,
      creator,
      mint.publicKey,
      receiver.publicKey,
      { commitment: 'confirmed' }
    );

    print(`mintTo`);
    await spl.mintTo(
      provider.connection,
      creator,
      mint.publicKey,
      creatorTokenAccount,
      creator.publicKey,
      100 * (10 ** 6),
    );

  });

  it('initialize account', async () => {

    const [userAccountPk] = await anchor.web3.PublicKey.findProgramAddress(
      [
        creator.publicKey.toBuffer(),
        Buffer.from('user'),
      ],
      program.programId,
    );
    userAccount = userAccountPk;

    await program
      .methods
      .initializeUser()
      .accounts(
        {
          creator: creator.publicKey,
          user: userAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
        }
      )
      .signers([creator])
      .rpc({ skipPreflight: true });
    // const tx = new anchor.web3.Transaction();

    // tx.add(
    //   await program
    //     .methods
    //     .initializeUser()
    //     .accounts(
    //       {
    //         creator: creator.publicKey, 
    //         user: userAccount,
    //         systemProgram: anchor.web3.SystemProgram.programId,
    //       }
    //     )
    //     .instruction()
    // );

    // await provider.sendAndConfirm(tx, [creator], {skipPreflight: true});

    print(`userAccount: ${userAccount}`);
    const userAccountData = await program.account.user.fetch(userAccount);
    const buffer = Buffer.alloc(8);
    nu64().encode(userAccountData.count, buffer);

    const [multisigAccountPk] = await anchor.web3.PublicKey.findProgramAddress(
      [
        creator.publicKey.toBuffer(),
        buffer,
        Buffer.from('multisig'),
      ],
      program.programId,
    );

    multisigAccount = multisigAccountPk;
    print(`multisigAccount: ${multisigAccount}`);

    await program
      .methods
      .initializeMultisig(
        [creator.publicKey, owner1.publicKey, owner2.publicKey],
        2
      )
      .accounts(
        {
          creator: creator.publicKey,
          user: userAccount,
          multisigAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
        },
      )
      .signers([creator])
      .rpc();

    let multisigAccountData = await program.account.multisig.fetch(multisigAccount);

    print(`multisigAccountData: ${JSON.stringify(multisigAccountData)}`);
    assert.strictEqual(multisigAccountData.threshold, 2);


    const buffer1 = Buffer.alloc(8);
    nu64().encode(userAccountData.count, buffer1);
    const buffer2 = Buffer.alloc(8);
    nu64().encode(userAccountData.count, buffer1);
    const [transactionAccountPk] = await anchor.web3.PublicKey.findProgramAddress(
      [
        multisigAccount.toBuffer(),
        buffer1,
        Buffer.from('transaction'),
      ],
      program.programId,
    );
    transactionAccount = transactionAccountPk;
    print(`transactionAccountPk ${transactionAccountPk}`);

    const beforeCreator = await provider.connection.getAccountInfo(creator.publicKey);
    print(`beforeCreator: ${beforeCreator.lamports}`);

    const beforeCreatorToken = await spl.getAccount(provider.connection, creatorTokenAccount);
    print(`beforeCreatorToken: ${beforeCreatorToken.amount}`);

    vaultTokenAccount = (await spl.getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      mint.publicKey,
      transactionAccount,
      true,
      // 'confirmed',
    )).address;

    const beforeVaultToken = await spl.getAccount(provider.connection, vaultTokenAccount);
    print(`beforeVaultToken: ${beforeVaultToken.amount}`);

    const transferAmount = new anchor.BN(10 * (10 ** 6));
    await program
      .methods
      .createTransaction(transferAmount)
      .accounts({
        creator: creator.publicKey,
        receiver: receiver.publicKey,
        multisigAccount,
        transactionAccount,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(
        [
          { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          { pubkey: creatorTokenAccount, isSigner: false, isWritable: true },
          { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
        ]
      )
      .signers([creator])
      .rpc({ skipPreflight: true });

    const afterCreator = await provider.connection.getAccountInfo(creator.publicKey);
    print(`afterCreator lamports: ${afterCreator.lamports}`);

    const txAccount = await provider.connection.getAccountInfo(transactionAccount);
    print(`txAccount lamports: ${txAccount.lamports}`);

    const afterCreatorToken = await spl.getAccount(provider.connection, creatorTokenAccount);
    print(`afterCreatorToken: ${afterCreatorToken.amount}`);

    const afterVaultToken = await spl.getAccount(provider.connection, vaultTokenAccount);
    print(`afterVaultToken: ${afterVaultToken.amount}`);

    multisigAccountData = await program.account.multisig.fetch(multisigAccount);
    assert.strictEqual(multisigAccountData.txCount.toNumber(), 1);

    let transactionAccountData = await program.account.transaction.fetch(transactionAccount);
    assert.strictEqual(transactionAccountData.amount.toNumber(), transferAmount.toNumber());
    assert.strictEqual(transactionAccountData.txCount.toNumber(), 0);

    print(`transactionAccount owners: ${transactionAccountData.owners}`);

  });


  it('approve', async () => {
    let transactionAccountData = await program.account.transaction.fetch(transactionAccount);

    print(`transaction owners: ${transactionAccountData.owners}`);
    print(`transaction signs: ${transactionAccountData.signs}`);

    await program
      .methods
      .approveTransaction()
      .accounts(
        {
          payer: owner1.publicKey,
          transactionAccount,
        }
      ).signers([owner1])
      .rpc();

    transactionAccountData = await program.account.transaction.fetch(transactionAccount);

    print(`transaction owners: ${transactionAccountData.owners}`);
    print(`transaction signs: ${transactionAccountData.signs}`);
  });

  it('execute transaction', async () => {
    const beforeTransactionAccount = await provider.connection.getAccountInfo(transactionAccount);
    print(`beforeTransactionAccount lamports: ${beforeTransactionAccount.lamports}`);

    const beforeReceiver = await provider.connection.getAccountInfo(receiver.publicKey);
    print(`beforeReceiver lamports: ${beforeReceiver.lamports}`);

    const beforeVaultToken = await spl.getAccount(provider.connection, vaultTokenAccount);
    print(`beforeVaultToken: ${beforeVaultToken.amount}`);

    await program
      .methods
      .executeTransaction()
      .accounts(
        {
          payer: owner2.publicKey,
          receiver: receiver.publicKey,
          multisigAccount,
          transactionAccount,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
      )
      .remainingAccounts(
        [
          { pubkey: mint.publicKey, isSigner: false, isWritable: false },
          { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
          { pubkey: receiverTokenAccount, isSigner: false, isWritable: true },
        ]
      )
      .signers([owner2])
      .rpc({ skipPreflight: true });

    const afterTransactionAccount = await provider.connection.getAccountInfo(transactionAccount);
    print(`afterTransactionAccount lamports: ${afterTransactionAccount.lamports}`);
    const afterReceiver = await provider.connection.getAccountInfo(receiver.publicKey);
    print(`afterReceiver lamports: ${afterReceiver.lamports}`);

    const afterVaultToken = await spl.getAccount(provider.connection, vaultTokenAccount);
    print(`afterVaultToken: ${afterVaultToken.amount}`);

    const receiverVaultToken = await spl.getAccount(provider.connection, receiverTokenAccount);
    print(`receiverVaultToken: ${receiverVaultToken.amount}`);
  });
});
*/
