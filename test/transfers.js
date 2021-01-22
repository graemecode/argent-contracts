/* global artifacts */

const truffleAssert = require("truffle-assertions");
const ethers = require("ethers");
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

const ERC20 = artifacts.require("TestERC20");
const WETH = artifacts.require("WETH9");
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
    const recipient = accounts[4];
  
    let registry;
    let lockStorage;
    let transferStorage;
    let guardianStorage;
    let transactionManager;
    let wallet;
    let walletImplementation;
    let erc20;
    let weth;

    before(async () => {
        weth = await WETH.new();
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
    });

    beforeEach(async () => {
        const proxy = await Proxy.new(walletImplementation.address);
        wallet = await BaseWallet.at(proxy.address);
        await wallet.init(owner, [transactionManager.address]);
    
        const decimals = 12; // number of decimal for TOKN contract
        const tokenRate = new BN(10).pow(new BN(19)).muln(51); // 1 TOKN = 0.00051 ETH = 0.00051*10^18 ETH wei => *10^(18-decimals) = 0.00051*10^18 * 10^6 = 0.00051*10^24 = 51*10^19
    
        erc20 = await ERC20.new([infrastructure, wallet.address], 10000000, decimals); // TOKN contract with 10M tokens (5M TOKN for wallet and 5M TOKN for account[0])
        await wallet.send(new BN("1000000000000000000"));
    });

    async function encodeTransaction(to, value, data) {
        return web3.eth.abi.encodeParameters(
          ['address', 'uint256', 'bytes'],
          [to, value, data]
        );
      }

    describe("transfer ETH", () => {
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

        it("should send ETH to a whitelisted address", async () => {
            let transaction = await encodeTransaction(recipient, 10, ZERO_BYTES32);

            let txReceipt = await manager.relay(
                transactionManager,
                "multiCallWithWhitelist",
                [wallet.address, [transaction], [false]],
                wallet,
                [owner],
                1,
                ETH_TOKEN,
                recipient);
            success = await utils.parseRelayReceipt(txReceipt).success;
            assert.isTrue(success, "transfer failed");
        });

        it("should send ERC20 to a whitelisted address", async () => {
            let data = erc20.contract.methods.transfer(recipient, 100).encodeABI();
            let transaction = await encodeTransaction(erc20.address, 0, data);

            let txReceipt = await manager.relay(
                transactionManager,
                "multiCallWithWhitelist",
                [wallet.address, [transaction], [true]],
                wallet,
                [owner],
                1,
                ETH_TOKEN,
                recipient);
            success = await utils.parseRelayReceipt(txReceipt).success;
            assert.isTrue(success, "transfer failed");
            let balance = await erc20.balanceOf(recipient);
            assert.equal(balance, 100, "should have received tokens");
        });

        it("should approve ERC20 for a whitelisted address", async () => {
            let data = erc20.contract.methods.approve(recipient, 100).encodeABI();
            let transaction = await encodeTransaction(erc20.address, 0, data);

            let txReceipt = await manager.relay(
                transactionManager,
                "multiCallWithWhitelist",
                [wallet.address, [transaction], [true]],
                wallet,
                [owner],
                1,
                ETH_TOKEN,
                recipient);
            success = await utils.parseRelayReceipt(txReceipt).success;
            assert.isTrue(success, "transfer failed");
            let balance = await erc20.allowance(wallet.address, recipient);
            assert.equal(balance, 100, "should have been approved tokens");
        });
    });
});