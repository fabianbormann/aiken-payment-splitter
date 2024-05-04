# Aiken Payment Splitter

A simple payment splitter validator written in Aiken and its off-chain counterpart. The Aiken code is in the `onchain` directory and the off-chain code is in the `offchain` directory.

## On-chain

### Prerequirements

- [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

### Test and build

```bash
cd onchain
aiken test
aiken build
```

## Off-chain

### Prerequirements

- Node >= 16
- Yarn

### Prepare a list of wallets

```bash
cd offchain
yarn install
node use-payment-splitter.js prepare 5
```

### Top up the wallets

Copy the address from the output of the previous command and send some test Ada on the preprod network to this address.
If you don't have test Ada at all, you can get some from the [Cardano Testnets Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

### Send 10 tAda to the payment splitter

```bash
node use-payment-splitter.js lock 10000000
```

### Trigger a payout

```bash
node use-payment-splitter.js unlock
```