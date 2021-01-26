/* global artifacts */

const truffleAssert = require("truffle-assertions");
const ethers = require("ethers");
const chai = require("chai");
const BN = require("bn.js");
const bnChai = require("bn-chai");

const { expect } = chai;
chai.use(bnChai(BN));

// Paraswap
const AugustusSwapper = artifacts.require("AugustusSwapper");
const Whitelisted = artifacts.require("Whitelisted");
const PartnerRegistry = artifacts.require("PartnerRegistry");
const PartnerDeployer = artifacts.require("PartnerDeployer");
const Kyber = artifacts.require("Kyber");
const UniswapV2 = artifacts.require("UniswapV2");

// Kyber
const KyberNetwork = artifacts.require("KyberNetworkTest");

// UniswapV2
const UniswapV2Factory = artifacts.require("UniswapV2Factory");
const UniswapV2Router01 = artifacts.require("UniswapV2Router01");
const WETH = artifacts.require("WETH9");

// Argent
const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const Registry = artifacts.require("ModuleRegistry");
const LockStorage = artifacts.require("LockStorage");
const TransferStorage = artifacts.require("TransferStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const TransactionManager = artifacts.require("TransactionManager");
const Authoriser = artifacts.require("DappAuthoriser");
const Filter = artifacts.require("TestFilter");
const ERC20 = artifacts.require("TestERC20");

// Utils
const { makePathes } = require("../utils/paraswap/sell-helper");
const { makeRoutes } = require("../utils/paraswap/buy-helper");
const utils = require("../utils/utilities.js");
const { ETH_TOKEN } = require("../utils/utilities.js");
const ZERO_BYTES32 = ethers.constants.HashZero;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const SECURITY_PERIOD = 2;

// Constants
const DECIMALS = 18; // number of decimal for TOKEN_A, TOKEN_B contracts
const TOKEN_A_RATE = web3.utils.toWei("0.06");
const TOKEN_B_RATE = web3.utils.toWei("0.03");

const RelayManager = require("../utils/relay-manager");
const { assert } = require("chai");

contract("TransactionManager", (accounts) => {
    const manager = new RelayManager();

    const infrastructure = accounts[0];
    const owner = accounts[1];
    const recipient = accounts[4];
    const nonceInitialiser = accounts[4];
  
    let registry;
    let lockStorage;
    let transferStorage;
    let guardianStorage;
    let transactionManager;
    let wallet;
    let walletImplementation;
    let filter;
    let authoriser;
    let kyberNetwork;
    let kyberAdapter;
    let uniswapRouter;
    let uniswapV2Adapter;
    let tokenA;
    let tokenB;
    let paraswap;
    let paraswapProxy;

    before(async () => {

        // Deploy test tokens
        tokenA = await ERC20.new([infrastructure], web3.utils.toWei("1000"), DECIMALS);
        tokenB = await ERC20.new([infrastructure], web3.utils.toWei("1000"), DECIMALS);

        // Deploy and fund Kyber
        kyberNetwork = await KyberNetwork.new();
        await tokenA.mint(kyberNetwork.address, web3.utils.toWei("1000"));
        await tokenB.mint(kyberNetwork.address, web3.utils.toWei("1000"));
        await kyberNetwork.addToken(tokenA.address, TOKEN_A_RATE, DECIMALS);
        await kyberNetwork.addToken(tokenB.address, TOKEN_B_RATE, DECIMALS);
        await kyberNetwork.send(web3.utils.toWei("10").toString());

        // Deploy and fund UniswapV2
        const uniswapFactory = await UniswapV2Factory.new(ZERO_ADDRESS);
        const weth = await WETH.new();
        uniswapRouter = await UniswapV2Router01.new(uniswapFactory.address, weth.address);
        await tokenA.approve(uniswapRouter.address, web3.utils.toWei("300"));
        await tokenB.approve(uniswapRouter.address, web3.utils.toWei("600"));
        const timestamp = await utils.getTimestamp();
        await uniswapRouter.addLiquidity(
        tokenA.address,
        tokenB.address,
        web3.utils.toWei("300"),
        web3.utils.toWei("600"),
        1,
        1,
        infrastructure,
        timestamp + 300,
        );

        // Deploy Paraswap
        const whitelist = await Whitelisted.new();
        const partnerDeployer = await PartnerDeployer.new();
        const partnerRegistry = await PartnerRegistry.new(partnerDeployer.address);
        paraswap = await AugustusSwapper.new(
        whitelist.address,
        infrastructure,
        partnerRegistry.address,
        infrastructure,
        infrastructure,
        );
        kyberAdapter = await Kyber.new(infrastructure);
        uniswapV2Adapter = await UniswapV2.new(weth.address);
        await whitelist.addWhitelisted(kyberAdapter.address);
        await whitelist.addWhitelisted(uniswapV2Adapter.address);
        paraswapProxy = await paraswap.getTokenTransferProxy();

        // deploy Argent
        registry = await Registry.new();
        
        filter = await Filter.new();
        authoriser = await Authoriser.new();

        lockStorage = await LockStorage.new();
        guardianStorage = await GuardianStorage.new();
        transferStorage = await TransferStorage.new();

        transactionManager = await TransactionManager.new(
            registry.address,
            lockStorage.address,
            guardianStorage.address,
            transferStorage.address,
            authoriser.address,
            SECURITY_PERIOD);
      
        await registry.registerModule(transactionManager.address, ethers.utils.formatBytes32String("TransactionManager"));
    
        walletImplementation = await BaseWallet.new();
    
        await manager.setRelayerManager(transactionManager);    
    });

    beforeEach(async () => {
        // create wallet
        const proxy = await Proxy.new(walletImplementation.address);
        wallet = await BaseWallet.at(proxy.address);
        await wallet.init(owner, [transactionManager.address]);
    
        // fund wallet
        await wallet.send(web3.utils.toWei("0.1"));
        await tokenA.mint(wallet.address, web3.utils.toWei("1000"));
        await tokenB.mint(wallet.address, web3.utils.toWei("1000"));
    });

    async function encodeTransaction(to, value, data, isSpenderInData = false) {
        return {to, value, data, isSpenderInData};
    }

    async function whitelist(target) {
        await transactionManager.addToWhitelist(wallet.address, target, { from: owner });
        await utils.increaseTime(3);
        isTrusted = await transactionManager.isWhitelisted(wallet.address, target);
        assert.isTrue(isTrusted, "should be trusted after the security period");
    }

    async function initNonce() {
        // add to whitelist
        await whitelist(nonceInitialiser);
        // set the relayer nonce to > 0
        let transaction = await encodeTransaction(nonceInitialiser, 1, ZERO_BYTES32, false);
        let txReceipt = await manager.relay(
            transactionManager,
            "multiCall",
            [wallet.address, [transaction]],
            wallet,
            [owner]);
        success = await utils.parseRelayReceipt(txReceipt).success;
        assert.isTrue(success, "transfer failed");
    }

    async function getBalance(tokenAddress, _wallet) {
        let balance;
        if (tokenAddress === ETH_TOKEN) {
          balance = await utils.getBalance(_wallet.address);
        } else if (tokenAddress === tokenA.address) {
          balance = await tokenA.balanceOf(_wallet.address);
        } else {
          balance = await tokenB.balanceOf(_wallet.address);
        }
        return balance;
    }

    function getRoutes({
        fromToken, toToken, srcAmount, destAmount, minConversionRateForBuy = "1",
      }) {
        const exchange = [toToken, fromToken].includes(ETH_TOKEN) ? "kyber" : "uniswapV2";
        const payload = exchange === "kyber" ? { minConversionRateForBuy } : {
          path: [
            fromToken,
            toToken,
          ],
        };
        const routes = [
          {
            exchange,
            percent: "100",
            srcAmount: srcAmount.toString(),
            destAmount: destAmount.toString(),
            data: {
              tokenFrom: fromToken,
              tokenTo: toToken,
              ...payload,
            },
          },
        ];
        return routes;
      }

    function buildPathes({
        fromToken, toToken, srcAmount, destAmount,
      }) {
        const routes = getRoutes({
          fromToken, toToken, srcAmount, destAmount,
        });
        const exchanges = { kyber: kyberAdapter.address, uniswapv2: uniswapV2Adapter.address };
        const targetExchanges = { kyber: kyberNetwork.address, uniswapv2: uniswapRouter.address };
        return makePathes(fromToken, toToken, routes, exchanges, targetExchanges, false);
      }

    function buildRoutes({
        fromToken, toToken, srcAmount, destAmount,
      }) {
        const routes = getRoutes({
          fromToken, toToken, srcAmount, destAmount,
        });
        const exchanges = { kyber: kyberAdapter.address, uniswapv2: uniswapV2Adapter.address };
        const targetExchanges = { kyber: kyberNetwork.address, uniswapv2: uniswapRouter.address };
        return makeRoutes(fromToken, toToken, routes, exchanges, targetExchanges);
    }

    async function testTrade({
        method, fromToken, toToken,
      }) {
        const beforeFrom = await getBalance(fromToken, wallet);
        const beforeTo = await getBalance(toToken, wallet);
        const fixedAmount = web3.utils.toWei("0.01");
        const variableAmount = method === "sell" ? 1 : beforeFrom;
    
        // wallet should have enough of fromToken
        if (method === "sell") { expect(beforeFrom).to.be.gte.BN(fixedAmount); }

        let srcAmount;
        let destAmount;
        let path;
        let data;
        let value;
        let transaction;
        let transactions = [];

        if (method === "sell") {
            srcAmount = fixedAmount;
            destAmount = variableAmount;
            path = buildPathes({
              fromToken, toToken, srcAmount, destAmount,
            });
        } else if (method === "buy") {
            srcAmount = variableAmount;
            destAmount = fixedAmount;
            path = buildRoutes({
            fromToken, toToken, srcAmount, destAmount,
        });
        } else {
            throw new Error("Unsupported method:", method);
        }

        // approve token if necessary
        if(fromToken === ETH_TOKEN) {
            value = srcAmount;
        }
        else {
            value = 0;
            if (fromToken === tokenA.address) {
                data = tokenA.contract.methods.approve(paraswapProxy, srcAmount).encodeABI();
            } else {
                data = tokenB.contract.methods.approve(paraswapProxy, srcAmount).encodeABI();
            }
            transaction = await encodeTransaction(fromToken, 0, data, true);
            transactions.push(transaction); 
        }

        // swap
        data = paraswap.contract.methods.multiSwap(
            fromToken,
            toToken,
            srcAmount,
            destAmount,
            0,
            path,
            0,
            ZERO_ADDRESS,
            0,
            "abc",
        ).encodeABI();
        transaction = await encodeTransaction(paraswap.address, value, data);
        transactions.push(transaction); 

        let txReceipt = await manager.relay(
            transactionManager,
            "multiCall",
            [wallet.address, transactions],
            wallet,
            [owner],
            1,
            ETH_TOKEN,
            recipient);
        let { success, error } = await utils.parseRelayReceipt(txReceipt);
        if (!success) console.log(error);
        assert.isTrue(success, "transfer failed");
        console.log("Gas to swap: " + txReceipt.gasUsed);
    
        const afterFrom = await getBalance(fromToken, wallet);
        const afterTo = await getBalance(toToken, wallet);

        expect(beforeFrom).to.be.gt.BN(afterFrom);
        expect(afterTo).to.be.gt.BN(beforeTo);
      }

    describe("multi swap", () => {
        beforeEach(async () => {
            initNonce();
            await authoriser.addAuthorisation(paraswap.address, ZERO_ADDRESS);
            await authoriser.addAuthorisation(paraswapProxy, ZERO_ADDRESS);
        });
        
        it("should sell ETH for token", async () => {
            await testTrade({
                method: "sell", fromToken: ETH_TOKEN, toToken: tokenA.address,
            });
        });

        it("should sell token for ETH", async () => {
            await testTrade({
                method: "sell", fromToken: tokenA.address, toToken: ETH_TOKEN,
            });
        });

        it("should sell tokenA for tokenB", async () => {
            await testTrade({
                method: "sell", fromToken: tokenB.address, toToken: tokenA.address,
            });
        });
    });
});