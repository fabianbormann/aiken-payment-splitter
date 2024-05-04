import { AppWallet, KoiosProvider, 
  resolvePlutusScriptAddress, resolvePaymentKeyHash, Transaction, largestFirst } from '@meshsdk/core';
import { fromHex, C } from 'lucid-cardano'
import * as fs from 'fs';
import { utils } from '@stricahq/typhonjs';

const prepare = async (amount) => {
  let mnemonic = AppWallet.brew();
  const koiosProvider = new KoiosProvider('preprod');
  
  let addresses = [];
  for (let i = 0; i < amount; i++) {
    const wallet = new AppWallet({
        networkId: 0,
        fetcher: koiosProvider,
        submitter: koiosProvider,
        key: {
            type: 'mnemonic',
            words: mnemonic,
        },
    });
    addresses.push(utils.getAddressFromString(wallet.getPaymentAddress()));
    
    fs.writeFileSync(`payee_${i}.txt`, JSON.stringify(mnemonic));
    mnemonic = AppWallet.brew();
  }
  console.log(`Successfully prepared ${amount} payees (seed phrases).`);
  console.log(`Make sure to send some tADA to the payee 0 ${addresses[0].getBech32()} 
  as this will payee will be used in this example, to submit the transaction. 
  Therefore enough tAda for the fees and to provide a collateral will be needed.`);
}

const setup = async () => {
  const koiosProvider = new KoiosProvider('preprod');
  const plutusScript = JSON.parse(fs.readFileSync("../onchain/plutus.json", "utf8"));
  const mnemonic = JSON.parse(fs.readFileSync("payee_0.txt", "utf8"));

  const wallet = new AppWallet({
    networkId: 0,
    fetcher: koiosProvider,
    submitter: koiosProvider,
    key: {
      type: 'mnemonic',
      words: mnemonic,
    },
  });

  const payeeSeeds = fs.readdirSync('.').filter((filename) => 
    filename.match(/payee_[0-9]+.txt/) !== null);

  const payees = [];
  for (let i = 0; i < payeeSeeds.length; i++) {
    const seed = JSON.parse(fs.readFileSync(`payee_${i}.txt`, "utf8"));
    const payee = new AppWallet({
      networkId: 0,
      fetcher: koiosProvider,
      submitter: koiosProvider,
      key: {
        type: 'mnemonic',
        words: seed,
      },
    });
    payees.push(payee.getPaymentAddress());
  }

  const paymentHashes = C.PlutusList.new();
  const bytesFromHex = s => {
      if (!/^[a-f0-9]*$/i.test(s)) {
          throw new Error(`invalid hex: ${s}`);
      }
      return Buffer.from(s, "hex");
  }

  for (const paymentHash of payees.map(resolvePaymentKeyHash)) {
    paymentHashes.add(C.PlutusData.new_bytes(bytesFromHex(paymentHash)))
  }

  const bytesToHex = (bytes) => Buffer.from(bytes).toString("hex")
  const applyDoubleCborEncoding = (script) => {
      try {
          C.PlutusScript.from_bytes(
              C.PlutusScript.from_bytes(fromHex(script)).bytes(),
          );
          return script;
      } catch (_e) {
          return bytesToHex(C.PlutusScript.new(fromHex(script)).to_bytes());
      }
  }

  const applyParamToScript = (param, script) => {
      const paramsList = C.PlutusList.new()
      paramsList.add(param)
      const plutusScript = C.apply_params_to_plutus_script(
          paramsList,
          C.PlutusScript.from_bytes(fromHex(applyDoubleCborEncoding(script))),
      )
      return bytesToHex(plutusScript.to_bytes());
  }

  const plutusData = C.PlutusData.new_list(paymentHashes);
  const parameterizedScript = applyParamToScript(plutusData, plutusScript.validators[0].compiledCode);

  const script = {
    code: parameterizedScript,
    version: "V2",
  };
  const scriptAddress = resolvePlutusScriptAddress(script, 0);

  return {
    koiosProvider,
    wallet,
    scriptAddress,
    script,
    payees
  }
}

const lockAda = async (lovelaceAmount) => {
  const { wallet, scriptAddress } = await setup();
  const paymentAddress = await wallet.getPaymentAddress();

  const hash = resolvePaymentKeyHash(paymentAddress);
  const datum = {
      alternative: 0,
      fields: [hash],
  };

  const tx = new Transaction({ initiator: wallet }).sendLovelace(
      {
      address: scriptAddress,
      datum: { value: datum }
      },
      lovelaceAmount
  );

  const unsignedTx = await tx.build();
  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);
  console.log(`Successfully locked ${lovelaceAmount} lovelace to the script address ${scriptAddress}.\n
  See: https://preprod.cexplorer.io/tx/${txHash}`);
};

const unlockAda = async () => {
  const { koiosProvider, wallet, scriptAddress, script, payees } = await setup();
  const utxos = await koiosProvider.fetchAddressUTxOs(scriptAddress);
  const paymentAddress = await wallet.getPaymentAddress();

  const lovelaceForCollateral = "6000000";
  const collateralUtxos = largestFirst(lovelaceForCollateral, await koiosProvider.fetchAddressUTxOs(paymentAddress));
  const hash = resolvePaymentKeyHash(paymentAddress);
  const datum = {
      alternative: 0,
      fields: [hash],
  };

  const redeemerData = "Hello, World!";
  const redeemer = { data: { alternative: 0, fields: [redeemerData] } };

  let tx = new Transaction({ initiator: wallet })
  let split = 0;
  for (const utxo of utxos) {
    const amount = utxo.output?.amount;
    if (amount) {
      let lovelace = amount.find((asset) => asset.unit === 'lovelace');
      if (lovelace) {
        split += Math.floor(Number(lovelace.quantity) / payees.length);
      }

      tx = tx.redeemValue({
        value: utxo,
        script: script,
        datum: datum,
        redeemer: redeemer,
      })
    }
  }

  tx = tx.setCollateral(collateralUtxos);
  for (const payee of payees) {    
      tx = tx.sendLovelace(
          payee,
          split.toString()
      )
  }

  tx = tx.setRequiredSigners([paymentAddress]);
  const unsignedTx = await tx.build();
  try {
    const signedTx = await wallet.signTx(unsignedTx, true);
    const txHash = await wallet.submitTx(signedTx);
    console.log(`Successfully unlocked the lovelace from the script address ${scriptAddress} and split it equally (${split} Lovelace) to all payees.\n
    See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.warn(error);
  }
};

const args = process.argv.slice(2);
const isPositiveNumber = (s) => Number.isInteger(Number(s)) && Number(s) > 0

if (args.length > 0) {
  if (args[0] === 'lock') {
    if (args.length > 1 && isPositiveNumber(args[1])) {
      lockAda(args[1]);
    } else {
      console.log('Expected a positive number (lovelace amount) as the second argument.');
      console.log('Example usage: node use-payment-splitter.js lock 10000000');
    } 
  } else if (args[0] === 'unlock') {
    unlockAda();
  } else if (args[0] === 'prepare') {
    if (args.length > 1 && isPositiveNumber(args[1])) {
      const payeeSeeds = fs.readdirSync('.').filter((filename) => 
      filename.match(/payee_[0-9]+.txt/) !== null);

      if (payeeSeeds.length > 0) {
        console.log('Seed phrases (files with format payee_[0-9]+.txt) already exist. Please remove them before preparing new ones.');
      } else {
        prepare(args[1]);
      }
    } else {
      console.log('Expected a positive number (of seed phrases to prepare) as the second argument.');
      console.log('Example usage: node use-payment-splitter.js prepare 5');
    }    
  } else {
    console.log('Invalid argument. Allowed arguments are "lock", "unlock" or "prepare".');
    console.log('Example usage: node use-payment-splitter.js prepare');
  }
} else {
  console.log('Expected an argument. Allowed arguments are "lock", "unlock" or "prepare".');
  console.log('Example usage: node use-payment-splitter.js prepare 5');
}

