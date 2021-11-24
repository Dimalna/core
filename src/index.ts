import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";
import BigNumber from "bignumber.js";
import { OptionValues } from "commander";
import {
  Contract,
  ContractTransaction,
  ethers,
  constants,
  Wallet,
} from "ethers";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import Prando from "prando";
import { satisfies } from "semver";
import { ILogObject } from "tslog";
import {
  adjectives,
  starWars,
  uniqueNamesGenerator,
} from "unique-names-generator";
import { BlockInstructions, Bundle, BundlerFunction, Vote } from "./faces";
import { CLI } from "./utils";
import { fromBytes, toBytes } from "./utils/arweave";
import logger from "./utils/logger";
import {
  getGasPrice,
  toBN,
  toEthersBN,
  toHumanReadable,
  Pool,
  Token,
} from "./utils/helpers";
import NodeABI from "./abi/node.json";
import { version } from "../package.json";
import Transaction from "arweave/node/lib/transaction";
import hash from "object-hash";

export * from "./utils";

class KYVE {
  private pool: Contract;
  private node: Contract | null;
  private runtime: string;
  private version: string;
  private stake: string;
  private wallet: Wallet;
  private keyfile?: JWKInterface;
  private name: string;
  private gasMultiplier: string;

  private buffer: Bundle = [];
  private metadata: any;
  private settings: any;
  private config: any;

  private client = new Arweave({
    host: "arweave.net",
    protocol: "https",
  });

  constructor(
    poolAddress: string,
    runtime: string,
    version: string,
    stakeAmount: string,
    privateKey: string,
    keyfile?: JWKInterface,
    name?: string,
    endpoint?: string,
    gasMultiplier: string = "1"
  ) {
    const provider = new ethers.providers.WebSocketProvider(
      endpoint || "wss://moonbeam-alpha.api.onfinality.io/public-ws",
      {
        chainId: 1287,
        name: "moonbase-alphanet",
      }
    );
    provider._websocket.on("open", () => {
      setInterval(() => provider._websocket.ping(), 5000);
    });
    provider._websocket.on("close", () => {
      logger.error("❌ Websocket closed.");
      process.exit(1);
    });

    this.wallet = new Wallet(privateKey, provider);

    this.pool = Pool(poolAddress, this.wallet);
    this.node = null;
    this.runtime = runtime;
    this.version = version;
    this.stake = stakeAmount;
    this.keyfile = keyfile;
    this.gasMultiplier = gasMultiplier;

    if (name) {
      this.name = name;
    } else {
      const r = new Prando(this.wallet.address + this.pool.address);

      this.name = uniqueNamesGenerator({
        dictionaries: [adjectives, starWars],
        separator: "-",
        length: 2,
        style: "lowerCase",
        seed: r.nextInt(0, adjectives.length * starWars.length),
      }).replace(" ", "-");
    }

    if (!existsSync("./logs")) {
      mkdirSync("./logs");
    }

    const logToTransport = (log: ILogObject) => {
      appendFileSync(`./logs/${this.name}.txt`, JSON.stringify(log) + "\n");
    };

    logger.attachTransport({
      silly: logToTransport,
      debug: logToTransport,
      trace: logToTransport,
      info: logToTransport,
      warn: logToTransport,
      error: logToTransport,
      fatal: logToTransport,
    });
  }

  static async generate(
    cli?: CLI
  ): Promise<{ node: KYVE; options: OptionValues }> {
    if (!cli) {
      cli = new CLI(process.env.KYVE_RUNTIME!, process.env.KYVE_VERSION!);
    }
    await cli.parseAsync();
    const options = cli.opts();

    const node = new KYVE(
      options.pool,
      cli.runtime,
      cli.packageVersion,
      options.stake,
      options.privateKey,
      // if there is a keyfile flag defined, we load it from disk.
      options.keyfile && JSON.parse(readFileSync(options.keyfile, "utf-8")),
      options.name,
      options.endpoint,
      options.gasMultiplier
    );

    return {
      node,
      options,
    };
  }

  async start<ConfigType>(createBundle: BundlerFunction<ConfigType>) {
    this.logNodeInfo();

    await this.fetchPoolState();

    await this.checkVersionRequirements();
    await this.checkRuntimeRequirements();

    await this.setupNodeContract();
    await this.setupListeners();

    await this.run(createBundle);

    logger.info("💤 Exiting node ...");
  }

  private async run<ConfigType>(createBundle: BundlerFunction<ConfigType>) {
    let instructions: BlockInstructions | null = null;
    let uploadBundle: any = null;
    let downloadBundle: any = null;
    let transaction: Transaction | null = null;

    const runner = async () => {
      while (true) {
        if (instructions === null) {
          instructions = await this.getCurrentBlockInstructions();
        }

        if (instructions.uploader === ethers.constants.AddressZero) {
          logger.info("🔗 Claiming uploader slot for genesis block ...");

          const tx = await this.pool.claimGenesisUploader();
          await tx.wait();

          instructions = await this.getCurrentBlockInstructions();
        }

        logger.info("📚 Creating bundle ...");

        uploadBundle = await createBundle(
          this.config,
          instructions.fromHeight,
          instructions.toHeight
        );

        if (instructions.uploader === this.node?.address) {
          // create block proposal if node is chosen uploader
          transaction = await this.uploadBundleToArweave(
            uploadBundle,
            instructions
          );
          await this.submitBlockProposal(transaction, instructions);
        }

        instructions = await this.waitForNextBlockInstructions();

        if (instructions.uploader !== this.node?.address) {
          // pull down arweave data
          // vote
        }
      }
    };

    runner();
  }

  private async getCurrentBlockInstructions(): Promise<BlockInstructions> {
    const instructions = {
      ...(await this.pool._currentBlockInstructions()),
    };

    return {
      uploader: instructions._uploader,
      fromHeight: instructions._fromHeight,
      toHeight: instructions._toHeight,
    };
  }

  private async uploadBundleToArweave(
    bundle: any,
    instructions: BlockInstructions
  ): Promise<Transaction> {
    try {
      logger.info("💾 Uploading bundle to Arweave ...");

      const transaction = await this.client.createTransaction({
        data: JSON.stringify(bundle),
      });

      transaction.addTag("Application", "KYVE - Testnet");
      transaction.addTag("Pool", this.pool.address);
      transaction.addTag("@kyve/core", version);
      transaction.addTag(this.runtime, this.version);
      transaction.addTag("Uploader", instructions.uploader);
      transaction.addTag("FromHeight", instructions.fromHeight.toString());
      transaction.addTag("ToHeight", instructions.toHeight.toString());
      transaction.addTag("Content-Type", "application/json");

      await this.client.transactions.sign(transaction, this.keyfile);

      const balance = await this.client.wallets.getBalance(
        await this.client.wallets.getAddress(this.keyfile)
      );

      if (+transaction.reward > +balance) {
        logger.error("❌ You do not have enough funds in your Arweave wallet.");
        process.exit(1);
      }

      await this.client.transactions.post(transaction);

      logger.debug(`Arweave bundle = ${transaction.id}`);

      return transaction;
    } catch (error) {
      logger.error(
        "❌ Received an error while trying to create a block proposal:",
        error
      );
      process.exit(1);
    }
  }

  private async submitBlockProposal(
    transaction: Transaction,
    instructions: BlockInstructions
  ) {
    try {
      // manual gas limit for resources exhausted error
      const tx = await this.pool.submitBlockProposal(
        toBytes(transaction.id),
        +transaction.data_size,
        instructions.fromHeight,
        instructions.toHeight,
        {
          gasLimit: 10000000,
          gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
        }
      );

      logger.info(" Submitting new block proposal.");
      logger.debug(`Transaction = ${tx.hash}`);
    } catch (error) {
      logger.error(
        "❌ Received an error while submitting block proposal:",
        error
      );
      process.exit(1);
    }
  }

  private async waitForNextBlockInstructions(): Promise<BlockInstructions> {
    return new Promise((resolve) => {
      this.pool.on(
        "NextBlockInstructions",
        (uploader: string, fromHeight: number, toHeight: number) => {
          resolve({
            uploader,
            fromHeight,
            toHeight,
          });
        }
      );
    });
  }

  private async validateCurrentBlockProposal(uploadBundle: any) {
    const blockProposal = { ...(await this.pool._currentBlockProposal()) };
    const transaction = fromBytes(blockProposal._tx);
    const uploadBytes = blockProposal._bytes;

    try {
      const { status } = await this.client.transactions.getStatus(transaction);

      if (status === 200 || status === 202) {
        const _data = (await this.client.transactions.getData(transaction, {
          decode: true,
        })) as Uint8Array;
        const downloadBytes = _data.byteLength;
        const downloadBundle = JSON.parse(
          new TextDecoder("utf-8", {
            fatal: true,
          }).decode(_data)
        ) as Bundle;

        if (+uploadBytes === +downloadBytes) {
          const uploadBundleHash = hash(
            JSON.parse(JSON.stringify(uploadBundle))
          );
          const downloadBundleHash = hash(
            JSON.parse(JSON.stringify(downloadBundle))
          );

          this.vote({
            transaction,
            valid: uploadBundleHash === downloadBundleHash,
          });
        } else {
          logger.debug(
            `Bytes don't match. Uploaded data size = ${uploadBytes} Downloaded data size = ${downloadBytes}`
          );

          this.vote({
            transaction,
            valid: false,
          });
        }
      }
    } catch (err) {
      logger.error(`❌ Error fetching bundle from Arweave: ${err}`);
    }
  }

  private async vote(vote: Vote) {
    logger.info(
      `🖋 Voting "${vote.valid ? "valid" : "invalid"}" on bundle ${
        vote.transaction
      } ...`
    );

    try {
      await this.pool.vote(toBytes(vote.transaction), vote.valid, {
        gasLimit: await this.pool.estimateGas.vote(
          toBytes(vote.transaction),
          vote.valid
        ),
        gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
      });
    } catch (error) {
      logger.error("❌ Received an error while trying to vote:", error);
    }
  }

  private logNodeInfo() {
    const formatInfoLogs = (input: string) => {
      const length = Math.max(13, this.runtime.length);
      return input.padEnd(length, " ");
    };

    logger.info(
      `🚀 Starting node ...\n\t${formatInfoLogs("Name")} = ${
        this.name
      }\n\t${formatInfoLogs("Address")} = ${
        this.wallet.address
      }\n\t${formatInfoLogs("Pool")} = ${this.pool.address}\n\t${formatInfoLogs(
        "Desired Stake"
      )} = ${this.stake} $KYVE\n\n\t${formatInfoLogs(
        "@kyve/core"
      )} = v${version}\n\t${formatInfoLogs(this.runtime)} = v${this.version}`
    );
  }

  private async setupListeners() {
    // Listen to new contract changes.
    this.pool.on("ConfigChanged", () => {
      logger.warn("⚠️  Config changed. Exiting ...");
      process.exit();
    });
    this.pool.on("MetadataChanged", async () => {
      await this.fetchPoolState();
    });
    this.pool.on("Paused", () => {
      if (this.node?.address === this.settings.uploader) {
        logger.warn("⚠️  Pool is now paused. Exiting ...");
        process.exit();
      }
    });
    this.pool.on("UploaderChanged", (previous: string) => {
      if (this.node?.address === previous) {
        logger.warn("⚠️  Uploader changed. Exiting ...");
        process.exit();
      }
    });

    // Listen to new payouts.
    const payoutLogger = logger.getChildLogger({
      name: "Payout",
    });

    this.pool.on(
      this.pool.filters.PayedOut(this.node?.address),
      (_, _amount: ethers.BigNumber, _transaction: string) => {
        const transaction = fromBytes(_transaction);

        payoutLogger.info(
          `💸 Received a reward of ${toHumanReadable(
            toBN(_amount)
          )} $KYVE. Bundle = ${transaction}`
        );
      }
    );

    // Listen to new points.
    const pointsLogger = logger.getChildLogger({
      name: "Points",
    });

    this.pool.on(
      this.pool.filters.PointsIncreased(this.node?.address),
      (_, _points: ethers.BigNumber, _transaction: string) => {
        const transaction = fromBytes(_transaction);

        pointsLogger.warn(
          `⚠️  Received a new slashing point (${_points.toString()} / ${
            this.settings.slashThreshold
          }). Bundle = ${transaction}`
        );
      }
    );

    // Listen to new slashes.
    const slashLogger = logger.getChildLogger({
      name: "Slash",
    });

    this.pool.on(
      this.pool.filters.Slashed(this.node?.address),
      (_, _amount: ethers.BigNumber, _transaction: string) => {
        const transaction = fromBytes(_transaction);

        slashLogger.warn(
          `🚫 Node has been slashed. Lost ${toHumanReadable(
            toBN(_amount)
          )} $KYVE. Bundle = ${transaction}`
        );
        process.exit();
      }
    );
  }

  private async fetchPoolState() {
    const stateLogger = logger.getChildLogger({
      name: "PoolState",
    });

    stateLogger.debug("Attempting to fetch pool state.");

    let _poolState;

    try {
      _poolState = await this.pool.poolState();
    } catch (error) {
      stateLogger.error(
        "❌ Received an error while trying to fetch the pool state:",
        error
      );
      process.exit(1);
    }

    try {
      this.config = JSON.parse(_poolState.config);
    } catch (error) {
      stateLogger.error(
        "❌ Received an error while trying to parse the config:",
        error
      );
      process.exit(1);
    }

    try {
      const oldMetadata = this.metadata;
      this.metadata = JSON.parse(_poolState.metadata);

      if (
        oldMetadata &&
        this.metadata.versions &&
        oldMetadata.versions !== this.metadata.versions
      ) {
        logger.warn("⚠️  Version requirements changed. Exiting ...");
        logger.info(
          `⏱  New version requirements are ${this.metadata.versions}.`
        );
        process.exit();
      }
    } catch (error) {
      stateLogger.error(
        "❌ Received an error while trying to parse the metadata:",
        error
      );
      process.exit(1);
    }

    this.settings = _poolState;

    stateLogger.debug("Successfully fetched pool state.");
  }

  private async checkVersionRequirements() {
    if (satisfies(this.version, this.metadata.versions || this.version)) {
      logger.info("⏱  Pool version requirements met.");
    } else {
      logger.error(
        `❌ Running an invalid version for the specified pool. Version requirements are ${this.metadata.versions}.`
      );
      process.exit(1);
    }
  }

  private async checkRuntimeRequirements() {
    if (this.metadata.runtime === this.runtime) {
      logger.info(`💻 Running node on runtime ${this.runtime}.`);
    } else {
      logger.error("❌ Specified pool does not match the integration runtime.");
      process.exit(1);
    }
  }

  private async setupNodeContract() {
    let nodeAddress = await this.pool._nodeOwners(this.wallet.address);
    let parsedStake;

    let tx: ContractTransaction;

    logger.info("🌐 Joining KYVE Network ...");

    if (constants.AddressZero === nodeAddress) {
      try {
        tx = await this.pool.createNode(10, {
          gasLimit: await this.pool.estimateGas.createNode(10),
          gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
        });

        logger.debug(`Creating new contract. Transaction = ${tx.hash}`);

        await tx.wait();

        nodeAddress = await this.pool._nodeOwners(this.wallet.address);
      } catch (error) {
        logger.error("❌ Could not create node contract:", error);
        process.exit(1);
      }
    }

    this.node = new Contract(nodeAddress, NodeABI, this.wallet);

    logger.info(`✅ Connected to node ${nodeAddress}`);

    let nodeStake = await this.node?.delegationAmount(this.wallet.address);

    try {
      parsedStake = new BigNumber(this.stake).multipliedBy(
        new BigNumber(10).exponentiatedBy(18)
      );

      if (parsedStake.isZero()) {
        logger.error("❌ Desired stake can't be zero.");
        process.exit(1);
      }
    } catch (error) {
      logger.error("❌ Provided invalid staking amount:", error);
      process.exit(1);
    }

    if (nodeStake.isZero()) {
      await this.selfDelegate(parsedStake);
    } else if (!toEthersBN(parsedStake).eq(nodeStake)) {
      await this.selfUndelegate();
      await this.selfDelegate(parsedStake);
    } else {
      logger.info("👌 Already staked with the correct amount.");
    }
  }

  private async selfDelegate(amount: BigNumber) {
    const token = await Token(this.pool);
    let tx: ContractTransaction;

    const balance = toBN(
      (await token.balanceOf(this.wallet.address)) as ethers.BigNumber
    );

    if (balance.lt(amount)) {
      logger.error("❌ Supplied wallet does not have enough $KYVE to stake.");
      process.exit(1);
    }

    try {
      tx = await token.approve(this.pool.address, toEthersBN(amount), {
        gasLimit: await token.estimateGas.approve(
          this.pool.address,
          toEthersBN(amount)
        ),
        gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
      });
      logger.debug(
        `Approving ${toHumanReadable(
          amount
        )} $KYVE to be spent. Transaction = ${tx.hash}`
      );

      await tx.wait();
      logger.info("👍 Successfully approved.");

      tx = await this.pool.delegate(this.node?.address, toEthersBN(amount), {
        gasLimit: await this.pool.estimateGas.delegate(
          this.node?.address,
          toEthersBN(amount)
        ),
        gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
      });
      logger.debug(
        `Staking ${toHumanReadable(amount)} $KYVE. Transaction = ${tx.hash}`
      );

      await tx.wait();
      logger.info("📈 Successfully staked.");
    } catch (error) {
      logger.error("❌ Received an error while trying to stake:", error);
      process.exit(1);
    }
  }

  private async selfUndelegate() {
    let tx: ContractTransaction;

    try {
      tx = await this.pool.undelegate(this.node?.address, {
        gasLimit: await this.pool.estimateGas.undelegate(this.node?.address),
        gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
      });
      logger.debug(`Unstaking. Transaction = ${tx.hash}`);

      await tx.wait();
      logger.info("📉 Successfully unstaked.");
    } catch (error) {
      logger.error("❌ Received an error while trying to unstake:", error);
      process.exit(1);
    }
  }
}

export default KYVE;
