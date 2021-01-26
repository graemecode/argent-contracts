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
const SecurityManager = artifacts.require("SecurityManager");

const ERC20 = artifacts.require("TestERC20");
const TestContract = artifacts.require("TestContract");

const utils = require("../utils/utilities.js");
const { ETH_TOKEN } = require("../utils/utilities.js");
const ZERO_BYTES32 = ethers.constants.HashZero;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const SECURITY_PERIOD = 2;
const SECURITY_WINDOW = 2;
const LOCK_PERIOD = 2;
const RECOVERY_PERIOD = 2;

const RelayManager = require("../utils/relay-manager");
const { assert } = require("chai");

contract("SecurityManager", (accounts) => {
    const manager = new RelayManager();

    const infrastructure = accounts[0];
    const owner = accounts[1];
    const guardian1 = accounts[2];
    const newowner = accounts[5];
  
    let registry;
    let lockStorage;
    let guardianStorage;
    let transactionManager;
    let securityManager;
    let wallet;
    let walletImplementation;
    let erc20;

    before(async () => {
        registry = await Registry.new();

        lockStorage = await LockStorage.new();
        guardianStorage = await GuardianStorage.new();

        securityManager = await SecurityManager.new(
            registry.address,
            lockStorage.address,
            guardianStorage.address,
            RECOVERY_PERIOD,
            LOCK_PERIOD,
            SECURITY_PERIOD,
            SECURITY_WINDOW);
      
        await registry.registerModule(securityManager.address, ethers.utils.formatBytes32String("SecurityManager"));
    
        walletImplementation = await BaseWallet.new();
    
        await manager.setRelayerManager(securityManager);
    });

    beforeEach(async () => {
        const proxy = await Proxy.new(walletImplementation.address);
        wallet = await BaseWallet.at(proxy.address);
        await wallet.init(owner, [securityManager.address]);
    
        const decimals = 12; // number of decimal for TOKN contract
        erc20 = await ERC20.new([infrastructure, wallet.address], 10000000, decimals); // TOKN contract with 10M tokens (5M TOKN for wallet and 5M TOKN for account[0])
        await wallet.send(new BN("1000000000000000000"));
    });

      async function addGuardians(guardians) {
        // guardians can be BaseWallet or ContractWrapper objects
        for (const guardian of guardians) {
            await securityManager.addGuardian(wallet.address, guardian, { from: owner });
        }
    
        await utils.increaseTime(30);
        for (let i = 1; i < guardians.length; i += 1) {
          await securityManager.confirmGuardianAddition(wallet.address, guardians[i]);
        }
        const count = (await securityManager.guardianCount(wallet.address)).toNumber();
        assert.equal(count, guardians.length, `${guardians.length} guardians should be added`);
      }

    describe("recover wallet", () => {

        it("should recover wallet with 1 guardian", async () => {
            await addGuardians([guardian1]);

            let txReceipt = await manager.relay(
                securityManager,
                "executeRecovery",
                [wallet.address, newowner],
                wallet,
                [guardian1]);
            success = await utils.parseRelayReceipt(txReceipt).success;
            assert.isTrue(success, "execute recovery failed");
            console.log("Gas to execute recovery: " + txReceipt.gasUsed);

            await utils.increaseTime(40);

            tx = await securityManager.finalizeRecovery(wallet.address, { from: infrastructure });
            const walletOwner = await wallet.owner();
            assert.equal(walletOwner, newowner, "wallet owner should have been changed");
            console.log("Gas to finalize recovery: " + tx.receipt.gasUsed);
        });
    });
});