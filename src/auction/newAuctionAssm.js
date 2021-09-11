import {addAssemblerBid, getWalletAddress, isAssembler, isYoroi, showMsg,} from './helpers';
import {Address} from '@coinbarn/ergo-ts';
import {currencyToLong, decodeLongTuple, encodeHex, encodeLongTuple, encodeNum, longToCurrency} from './serializer';
import {follow, p2s} from "./assembler";
import {Serializer} from "@coinbarn/ergo-ts/dist/serializer";
import {additionalData, auctionAddress, supportedCurrencies, txFee} from "./consts";
import {currentBlock, sendTx} from "./explorer";
import {yoroiSendFunds} from "./yoroiUtils";
import moment from "moment";

const template = `{
  val userAddress = fromBase64("$userAddress")
  val bidAmount = $bidAmountL
  val endTime = $endTimeL
  val bidDelta = $bidDeltaL
  val currencyId = fromBase64("$currencyId")
  val buyItNow = $buyItNow
  val startAuction = {
      OUTPUTS(0).tokens.size > 0 &&
      OUTPUTS(0).R4[Coll[Byte]].getOrElse(INPUTS(0).id) == userAddress &&
      OUTPUTS(0).R5[Coll[Byte]].getOrElse(INPUTS(0).id) == userAddress &&
      OUTPUTS(0).R6[Coll[Long]].get(0) == bidAmount &&
      OUTPUTS(0).R6[Coll[Long]].get(1) == bidDelta &&
      OUTPUTS(0).R7[Long].getOrElse(0L) == endTime &&
      OUTPUTS(0).R8[Long].getOrElse(0L) == buyItNow &&
      (currencyId.size == 0 || (currencyId.size > 0 && OUTPUTS(0).tokens(1)._1 == currencyId)) 
  }
  val returnFunds = {
    val total = INPUTS.fold(0L, {(x:Long, b:Box) => x + b.value}) - 2000000
    OUTPUTS(0).value >= total && OUTPUTS(0).propositionBytes == userAddress && OUTPUTS.size == 2
  }
  sigmaProp((startAuction || returnFunds) && HEIGHT < $timestampL)
}`;

export async function registerAuction(
    initial,
    currency,
    buyItNow,
    step,
    end,
    description
) {
    const block = await currentBlock()
    const p2s = (await getAuctionP2s(initial, end, step, buyItNow, currency)).address
    const bidder = getWalletAddress()
    let tree = new Address(bidder).ergoTree;
    let info = `${initial},${block.timestamp},${description}`;

    let auctionErg = -1
    let auctionAssets = [
        {
            tokenId: "$userIns.token",
            amount: 0,
        },
    ]
    let start = {erg: supportedCurrencies.ERG.minSupported - txFee}
    if (currency.id.length > 0) {
        start[currency.id] = 0
        auctionAssets = [
            {
                tokenId: "$userIns.token",
                amount: 0,
            },
            {
                tokenId: currency.id,
                amount: -1,
            },
        ]
    }

    let reqs = [
        {
            address: auctionAddress,
            value: auctionErg,
            assets: auctionAssets,
            registers: {
                R4: await encodeHex(tree),
                R5: await encodeHex(tree),
                R6: await encodeLongTuple(initial, step),
                R7: await encodeNum(end.toString()),
                R8: await encodeNum(buyItNow.toString()),
                R9: await encodeHex(Serializer.stringToHex(info)),
            },
        },
    ]
    let request = {
        address: p2s,
        returnTo: bidder,
        startWhen: start,
        txSpec: {
            requests: reqs,
            fee: txFee,
            inputs: ['$userIns'],
            dataInputs: [additionalData.dataInput.boxId],
        },
    };
    return await follow(request)
        .then((res) => {
            if (res.id !== undefined) {
                let bid = {
                    id: res.id,
                    msg: "Your auction will be started soon!",
                    info: {
                        token: null,
                        boxId: null,
                        txId: null,
                        tx: null,
                        status: 'pending mining',
                        amount: initial,
                        currency: currency,
                        isFirst: true,
                    },
                };
                addAssemblerBid(bid);
            }
            res.address = p2s
            res.block = block
            return res;
        });
}

export async function getAuctionP2s(initial, end, step, buyItNow, currency) {
    let userAddress = getWalletAddress()
    let userTree = Buffer.from(new Address(userAddress).ergoTree, 'hex').toString('base64');
    let currencyID = Buffer.from(currency.id, 'hex').toString('base64');

    let script = template
        .replace('$userAddress', userTree)
        .replace('$bidAmount', initial)
        .replace('$endTime', end)
        .replace('$bidDelta', step)
        .replace('$currencyId', currencyID)
        .replace('$buyItNow', buyItNow)
        .replace('$timestamp', moment().valueOf())
        .replaceAll('\n', '\\n');
    return p2s(script);
}

export async function newAuctionHelper(
    initial,
    currency,
    buyItNow,
    step,
    end,
    description,
    selectedToken,
    amount,
    assemblerModal,
) {
    const r = await registerAuction(initial, currency, buyItNow, step, end, description)
    if (r.id === undefined) throw Error("Could not contact the assembler service")
    if (isAssembler()) {
        assemblerModal(r.address, longToCurrency(currency.initial, -1, currency.name), true, currency.name)
    } else if (isYoroi()) {
        let need = {ERG: supportedCurrencies.ERG.initial}
        need[selectedToken.value] = amount
        if (currency.id.length > 0)
            need[currency.id] = currency.initial
        console.log(need)
        return await yoroiSendFunds(need, r.address, r.block)
    }
}