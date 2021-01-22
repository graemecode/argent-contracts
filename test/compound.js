/* global artifacts */

const truffleAssert = require("truffle-assertions");
const ethers = require("ethers");
const { formatBytes32String } = require("ethers").utils;
const chai = require("chai");
const BN = require("bn.js");
const bnChai = require("bn-chai");

const { expect } = chai;
chai.use(bnChai(BN));

const TruffleContract = require("@truffle/contract");

const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const Registry = artifacts.require("ModuleRegistry");
const LockStorage = artifacts.require("LockStorage");
const TransferStorage = artifacts.require("TransferStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const TransactionManager = artifacts.require("TransactionManager");
const Authoriser = artifacts.require("DappAuthoriser");

// Compound
const Unitroller = artifacts.require("Unitroller");
const PriceOracle = artifacts.require("SimplePriceOracle");
const PriceOracleProxy = artifacts.require("PriceOracleProxy");
const Comptroller = artifacts.require("Comptroller");
const InterestModel = artifacts.require("WhitePaperInterestRateModel");
const CEther = artifacts.require("CEther");
const CErc20 = artifacts.require("CErc20");
const CToken = artifacts.require("CToken");
const CompoundRegistry = artifacts.require("CompoundRegistry");

const WAD = new BN("1000000000000000000"); // 10**18
const ETH_EXCHANGE_RATE = new BN("200000000000000000000000000");
const ERC20 = artifacts.require("TestERC20");

const TestContract = artifacts.require("TestContract");

const utils = require("../utils/utilities.js");
const { ETH_TOKEN } = require("../utils/utilities.js");
const ZERO_BYTES32 = ethers.constants.HashZero;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const SECURITY_PERIOD = 2;

const RelayManager = require("../utils/relay-manager");
const { assert } = require("chai");

contract("TransactionManager", (accounts) => {
    const manager = new RelayManager();

    const infrastructure = accounts[0];
    const owner = accounts[1];
    const liquidityProvider = accounts[2];
    const borrower = accounts[3];
    const recipient = accounts[4];
  
    let wallet;
    let walletImplementation;
    let registry;
    let lockStorage;
    let transferStorage;
    let guardianStorage;
    let transactionManager;
    let authoriser;
    let compoundRegistry;
    let token;
    let cToken;
    let cEther;
    let comptroller;
    let oracleProxy;

    before(async () => {
        /* Deploy Compound V2 Architecture */

        // deploy price oracle
        const oracle = await PriceOracle.new();

        // deploy comptroller
        const comptrollerProxy = await Unitroller.new();
        const comptrollerImpl = await Comptroller.new();
        await comptrollerProxy._setPendingImplementation(comptrollerImpl.address);
        await comptrollerImpl._become(comptrollerProxy.address, oracle.address, WAD.divn(10), 5, false);
        comptroller = await Comptroller.at(comptrollerProxy.address);
        // deploy Interest rate model
        const interestModel = await InterestModel.new(WAD.muln(250).divn(10000), WAD.muln(2000).divn(10000));
        // deploy CEther
        cEther = await CEther.new(
        comptrollerProxy.address,
        interestModel.address,
        ETH_EXCHANGE_RATE,
        formatBytes32String("Compound Ether"),
        formatBytes32String("cETH"),
        8,
        );

        // deploy token
        token = await ERC20.new([infrastructure, liquidityProvider, borrower], 10000000, 18);
        // deploy CToken
        cToken = await CErc20.new(
        token.address,
        comptroller.address,
        interestModel.address,
        ETH_EXCHANGE_RATE,
        "Compound Token",
        "cTOKEN",
        18,
        );
        // add price to Oracle
        await oracle.setUnderlyingPrice(cToken.address, WAD.divn(10));
        // list cToken in Comptroller
        await comptroller._supportMarket(cEther.address);
        await comptroller._supportMarket(cToken.address);
        // deploy Price Oracle proxy
        oracleProxy = await PriceOracleProxy.new(comptroller.address, oracle.address, cEther.address);
        await comptroller._setPriceOracle(oracleProxy.address);
        // set collateral factor
        await comptroller._setCollateralFactor(cToken.address, WAD.divn(10));
        await comptroller._setCollateralFactor(cEther.address, WAD.divn(10));

        // add liquidity to tokens
        const tenEther = await web3.utils.toWei("10");
        await cEther.mint({ value: tenEther, from: liquidityProvider });
        await token.approve(cToken.address, tenEther, { from: liquidityProvider });
        await cToken.mint(web3.utils.toWei("1"), { from: liquidityProvider });

        /* Deploy Argent Architecture */

        compoundRegistry = await CompoundRegistry.new();
        await compoundRegistry.addCToken(ETH_TOKEN, cEther.address);
        await compoundRegistry.addCToken(token.address, cToken.address);

        registry = await Registry.new();

        lockStorage = await LockStorage.new();
        guardianStorage = await GuardianStorage.new();
        transferStorage = await TransferStorage.new();

        transactionManager = await TransactionManager.new(
            registry.address,
            lockStorage.address,
            guardianStorage.address,
            transferStorage.address,
            ZERO_ADDRESS,
            SECURITY_PERIOD);
      
        await registry.registerModule(transactionManager.address, ethers.utils.formatBytes32String("TransactionManager"));
    
        walletImplementation = await BaseWallet.new();
    
        await manager.setRelayerManager(transactionManager);    

        authoriser = await Authoriser.new();
        await authoriser.addAuthorisation(cEther.address, ZERO_ADDRESS);
        await authoriser.addAuthorisation(cToken.address, ZERO_ADDRESS);
    });

    beforeEach(async () => {
        const proxy = await Proxy.new(walletImplementation.address);
        wallet = await BaseWallet.at(proxy.address);
        await wallet.init(owner, [transactionManager.address]);    
        await wallet.send(new BN("1000000000000000000"));
        await token.transfer(wallet.address, new BN("1000000000000000000"));
    });

    async function encodeTransaction(to, value, data) {
        return web3.eth.abi.encodeParameters(
          ['address', 'uint256', 'bytes'],
          [to, value, data]
        );
      }

    describe("Environment", () => {
        it("should deploy the environment correctly", async () => {
            const getCToken = await compoundRegistry.getCToken(token.address);
            assert.isTrue(getCToken === cToken.address, "cToken should be registered");
            const getCEther = await compoundRegistry.getCToken(ETH_TOKEN);
            assert.isTrue(getCEther === cEther.address, "cEther should be registered");
            const cOracle = await comptroller.oracle();
            assert.isTrue(cOracle === oracleProxy.address, "oracle should be registered");
            const cTokenPrice = await oracleProxy.getUnderlyingPrice(cToken.address);
            expect(cTokenPrice).to.eq.BN(WAD.divn(10));
            const cEtherPrice = await oracleProxy.getUnderlyingPrice(cEther.address);
            expect(cEtherPrice).to.eq.BN(WAD);
        });
    });

    describe("Investment", () => {
        async function accrueInterests(days, investInEth) {
            let tx;
            // generate borrows to create interests
            await comptroller.enterMarkets([cEther.address, cToken.address], { from: borrower });
      
            if (investInEth) {
              await token.approve(cToken.address, web3.utils.toWei("20"), { from: borrower });
              await cToken.mint(web3.utils.toWei("20"), { from: borrower });
              tx = await cEther.borrow(web3.utils.toWei("0.1"), { from: borrower });
              await utils.hasEvent(tx.receipt, CToken, "Borrow");
            } else {
              await cEther.mint({ value: web3.utils.toWei("2"), from: borrower });
              tx = await cToken.borrow(web3.utils.toWei("0.1"), { from: borrower });
              await utils.hasEvent(tx.receipt, CToken, "Borrow");
            }
            // increase time to accumulate interests
            await utils.increaseTime(3600 * 24 * days);
            await cToken.accrueInterest();
            await cEther.accrueInterest();
        }

        async function addInvestment(tokenAddress, days, amount) {
            let ctoken;
            let investInEth;
            let transactions = [];
            let istoken = [];

            if (tokenAddress === ETH_TOKEN) {
                ctoken = cEther;
                investInEth = true;

                let data = cEther.contract.methods.mint().encodeABI();
                let transaction = await encodeTransaction(cEther.address, amount, data);
                transactions.push(transaction); 
                istoken.push(false);
            } else {
                ctoken = cToken;
                investInEth = false;

                let data = token.contract.methods.approve(cToken.address, amount).encodeABI();
                let transaction = await encodeTransaction(token.address, 0, data);
                transactions.push(transaction); 
                istoken.push(true);

                data = cToken.contract.methods.mint(amount).encodeABI();
                transaction = await encodeTransaction(cToken.address, 0, data);
                transactions.push(transaction); 
                istoken.push(false);
            }

            let txReceipt = await manager.relay(
                transactionManager,
                "multiCallWithWhitelist",
                [wallet.address, transactions, istoken],
                wallet,
                [owner],
                1,
                ETH_TOKEN,
                recipient);
                console.log(txReceipt.rawLogs);
            success = await utils.parseRelayReceipt(txReceipt).success;
            assert.isTrue(success, "transfer failed");

            await utils.hasEvent(txReceipt, ctoken, "Mint");

            await accrueInterests(days, investInEth);

            return txReceipt;
          }

        beforeEach(async () => {
            // add to whitelist
            await transactionManager.addToWhitelist(wallet.address, recipient, { from: owner });
            await utils.increaseTime(3);
            isTrusted = await transactionManager.isWhitelisted(wallet.address, recipient);
            assert.isTrue(isTrusted, "should be trusted after the security period");
            // set the relayer nonce to > 0
            let transaction = await encodeTransaction(recipient, 1, ZERO_BYTES32);
            let txReceipt = await manager.relay(
                transactionManager,
                "multiCallWithWhitelist",
                [wallet.address, [transaction], [false]],
                wallet,
                [owner]);
            success = await utils.parseRelayReceipt(txReceipt).success;
            assert.isTrue(success, "transfer failed");
        });

        it("should invest ETH", async () => {
            await addInvestment(ETH_TOKEN, web3.utils.toWei("100"), 365);
            
        });

        // it("should invest ERC20", async () => {
        //     await addInvestment(token.address, web3.utils.toWei("100"), 365);
        // });
    });
});