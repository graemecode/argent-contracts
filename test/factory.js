/* global artifacts */
const ethers = require("ethers");
const truffleAssert = require("truffle-assertions");

const BaseWallet = artifacts.require("BaseWallet");
const Registry = artifacts.require("ModuleRegistry");
const Factory = artifacts.require("WalletFactory");
const GuardianStorage = artifacts.require("GuardianStorage");
const LockStorage = artifacts.require("LockStorage");
const TransferStorage = artifacts.require("TransferStorage");
const SecurityManager = artifacts.require("SecurityManager");
const TransactionManager = artifacts.require("TransactionManager");

const utils = require("../utils/utilities.js");

const ZERO_ADDRESS = ethers.constants.AddressZero;
const ZERO_BYTES32 = ethers.constants.HashZero;
const SECURITY_PERIOD = 2;
const SECURITY_WINDOW = 2;
const LOCK_PERIOD = 2;
const RECOVERY_PERIOD = 2;

contract("WalletFactory", (accounts) => {
  const infrastructure = accounts[0];
  const owner = accounts[1];
  const guardian = accounts[4];
  const other = accounts[6];

  let implementation;
  let moduleRegistry;
  let guardianStorage;
  let factory;
  let lockStorage;
  let transferStorage;
  let transactionManager;
  let securityManager;
  let modules;

  before(async () => {
    registry = await Registry.new();
    implementation = await BaseWallet.new();
    guardianStorage = await GuardianStorage.new();
    lockStorage = await LockStorage.new();
    transferStorage = await TransferStorage.new();

    factory = await Factory.new(
      registry.address,
      implementation.address,
      guardianStorage.address);
    await factory.addManager(infrastructure);

    
    transactionManager = await TransactionManager.new(
      registry.address,
      lockStorage.address,
      guardianStorage.address,
      transferStorage.address,
      ZERO_ADDRESS,
      SECURITY_PERIOD);

    securityManager = await SecurityManager.new(
      registry.address,
      lockStorage.address,
      guardianStorage.address,
      RECOVERY_PERIOD,
      LOCK_PERIOD,
      SECURITY_PERIOD,
      SECURITY_WINDOW);

    await registry.registerModule(transactionManager.address, ethers.utils.formatBytes32String("TransactionManager"));
    await registry.registerModule(securityManager.address, ethers.utils.formatBytes32String("SecurityManager"));

    modules = [transactionManager.address, securityManager.address];
  });

  describe("Create wallets with CREATE2", () => {

    it("should create a wallet at the correct address", async () => {
      const salt = utils.generateSaltValue();
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(
        owner, modules, guardian, salt,
      );
      const event = await utils.getEvent(tx.receipt, factory, "WalletCreated");
      const walletAddr = event.args.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
    });

    it("should create with the correct owner", async () => {
      const salt = utils.generateSaltValue();
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(
        owner, modules, guardian, salt,
      );
      const event = await utils.getEvent(tx.receipt, factory, "WalletCreated");
      const walletAddr = event.args.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
      // we test that the wallet has the correct owner
      const wallet = await BaseWallet.at(walletAddr);
      const walletOwner = await wallet.owner();
      assert.equal(walletOwner, owner, "should have the correct owner");
    });

    it("should create with the correct modules", async () => {
      const salt = utils.generateSaltValue();
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(
        owner, modules, guardian, salt,
      );
      const event = await utils.getEvent(tx.receipt, factory, "WalletCreated");
      const walletAddr = event.args.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
      // we test that the wallet has the correct modules
      const wallet = await BaseWallet.at(walletAddr);
      let count =  await wallet.modules();
      assert.equal(count, 2, "2 modules should be authorised");
      let isAuthorised = await wallet.authorised(modules[0]);
      assert.equal(isAuthorised, true, "first module should be authorised");
      isAuthorised = await wallet.authorised(modules[1]);
      assert.equal(isAuthorised, true, "second module should be authorised");
    });

    it("should create with the correct guardian", async () => {
      const salt = utils.generateSaltValue();
      // we get the future address
      const futureAddr = await factory.getAddressForCounterfactualWallet(owner, modules, guardian, salt);
      // we create the wallet
      const tx = await factory.createCounterfactualWallet(
        owner, modules, guardian, salt,
      );
      const event = await utils.getEvent(tx.receipt, factory, "WalletCreated");
      const walletAddr = event.args.wallet;
      // we test that the wallet is at the correct address
      assert.equal(futureAddr, walletAddr, "should have the correct address");
      // we test that the wallet has the correct guardian
      const success = await guardianStorage.isGuardian(walletAddr, guardian);
      assert.equal(success, true, "should have the correct guardian");
    });

    it("should create with the correct static calls", async () => {
      const salt = utils.generateSaltValue();
      const tx = await factory.createCounterfactualWallet(
        owner, modules, guardian, salt,
      );
      let event = await utils.getEvent(tx.receipt, factory, "WalletCreated");
      const walletAddr = event.args.wallet;
      wallet = await BaseWallet.at(walletAddr);

      const ERC1271_ISVALIDSIGNATURE_BYTES32 = utils.sha3("isValidSignature(bytes32,bytes)").slice(0, 10);
      const isValidSignatureDelegate = await wallet.enabled(ERC1271_ISVALIDSIGNATURE_BYTES32);
      assert.equal(isValidSignatureDelegate, transactionManager.address);

      const ERC721_RECEIVED = utils.sha3("onERC721Received(address,address,uint256,bytes)").slice(0, 10);
      const isERC721Received = await wallet.enabled(ERC721_RECEIVED);
      assert.equal(isERC721Received, transactionManager.address);
    });
  });
});
