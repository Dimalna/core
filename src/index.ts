import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";
import BigNumber from "bignumber.js";
import { Contract, ContractTransaction, ethers, Wallet } from "ethers";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import Prando from "prando";
import { satisfies } from "semver";
import { ILogObject } from "tslog";
import {
  adjectives,
  colors,
  animals,
  uniqueNamesGenerator,
} from "unique-names-generator";
import { BlockInstructions, BlockProposal } from "./faces";
import { CLI } from "./utils";
import {
  getGasPrice,
  toBN,
  toEthersBN,
  toHumanReadable,
  getPoolContract,
  getTokenContract,
  sleep,
  fromBytes,
  toBytes,
  formatBundle,
  parseBundle,
} from "./utils/helpers";
import { logger } from "./utils";
import { version } from "../package.json";
import Transaction from "arweave/node/lib/transaction";
import hash from "object-hash";
import http from "http";
import url from "url";
import client, { register } from "prom-client";
import level from "level";
import du from "du";

export * from "./utils";
export * from "./faces";
export * from "./utils/helpers";

client.collectDefaultMetrics({
  labels: { app: "kyve-core" },
});

class KYVE {
  protected pool: Contract;
  protected runtime: string;
  protected version: string;
  protected stake: string;
  protected commission: string;
  protected wallet: Wallet;
  protected keyfile?: JWKInterface;
  protected name: string;
  protected gasMultiplier: string;
  protected poolState: any;
  protected runMetrics: boolean;
  protected diskSpace: number;
  protected db: any;
  protected arweave = new Arweave({
    host: "arweave.net",
    protocol: "https",
  });

  public static metrics = client;

  constructor(cli?: CLI) {
    if (!cli) {
      cli = new CLI(process.env.KYVE_RUNTIME!, process.env.KYVE_VERSION!);
    }

    cli.parse();
    const options = cli.opts();

    const provider = new ethers.providers.StaticJsonRpcProvider(
      options.endpoint || "https://rpc.testnet.moonbeam.network",
      {
        chainId: 1287,
        name: "moonbase-alphanet",
      }
    );

    this.wallet = new Wallet(options.privateKey, provider);

    this.pool = getPoolContract(options.pool, this.wallet);
    this.runtime = cli.runtime;
    this.version = cli.packageVersion;
    this.stake = options.stake;
    this.commission = options.commission;
    this.keyfile =
      options.keyfile && JSON.parse(readFileSync(options.keyfile, "utf-8"));
    this.gasMultiplier = options.gasMultiplier;
    this.runMetrics = options.metrics;
    this.diskSpace = +options.space;
    this.name = options?.name ?? this.generateRandomName();

    if (!existsSync("./logs")) {
      mkdirSync("./logs");
    }

    const logToTransport = (log: ILogObject) => {
      appendFileSync(`./logs/${this.name}.txt`, JSON.stringify(log) + "\n");
    };

    logger.setSettings({
      minLevel: options.verbose ? undefined : "info",
    });

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

  async start() {
    this.logNodeInfo();
    this.setupMetrics();

    await this.fetchPoolState();
    await this.setupDB();

    await this.setupNodeStake();
    await this.setupNodeCommission();

    await this.checkIfNodeIsValidator();

    this.worker();
    this.run();
  }

  private async run() {
    try {
      logger.debug("Started runner ...");

      while (true) {
        await this.fetchPoolState();

        if (this.poolState.paused) {
          logger.info("💤  Pool is paused. Waiting ...");
          await sleep(60 * 1000);
          continue;
        }

        await this.checkIfNodeIsValidator();

        const blockInstructions = await this.getBlockInstructions();
        console.log(blockInstructions);

        this.db?.clear({ lt: this.poolState.height });

        if (
          blockInstructions.uploader === ethers.constants.AddressZero ||
          blockInstructions.uploader === this.wallet.address
        ) {
          const waitingTime = this.calculateUploaderWaitingTime();
          logger.debug(
            `Selected as uploader, waiting ${Math.ceil(
              waitingTime / 1000
            )}s for nodes to vote ...`
          );
          await sleep(waitingTime);
        }

        const usedDiskSpace = await du(`./db/${this.name}/`);

        logger.debug(
          `Creating bundle from height = ${blockInstructions.fromHeight} ...`
        );
        logger.debug(`Worker height = ${await this.db.get(-1).toString()} ...`);
        logger.debug(
          `Memory alloc of ${this.diskSpace} - ${(
            (usedDiskSpace * 100) /
            this.diskSpace
          ).toFixed(2)}`
        );

        // TODO: save last instructions and bundle

        const uploadBundle = await this.createBundle(blockInstructions);

        if (
          blockInstructions.uploader === ethers.constants.AddressZero ||
          blockInstructions.uploader === this.wallet.address
        ) {
          const transaction = await this.uploadBundleToArweave(
            uploadBundle,
            blockInstructions
          );

          if (transaction) {
            await this.submitBlockProposal(transaction, uploadBundle.length);
          }
        }

        await this.waitForNextBlockInstructions(blockInstructions);

        const blockProposal = await this.getBlockProposal();

        console.log(blockProposal);

        if (
          blockProposal.uploader !== ethers.constants.AddressZero &&
          blockProposal.uploader !== this.wallet.address
        ) {
          logger.debug(`Validating bundle ${blockProposal.txId} ...`);

          try {
            const { status } = await this.arweave.transactions.getStatus(
              blockProposal.txId
            );

            if (status === 200 || status === 202) {
              const _data = (await this.arweave.transactions.getData(
                blockProposal.txId,
                {
                  decode: true,
                }
              )) as Uint8Array;
              const downloadBytes = _data.byteLength;
              const downloadBundle = parseBundle(Buffer.from(_data));

              await this.vote({
                transaction: blockProposal.txId,
                valid: await this.validate(
                  uploadBundle,
                  +blockProposal.byteSize,
                  downloadBundle,
                  +downloadBytes
                ),
              });
            }
          } catch (error) {
            logger.error(
              `❌ Error fetching bundle from Arweave. Skipping vote ...`
            );
            logger.debug(error);
          }
        }
      }
    } catch (error) {
      logger.error(`❌ Runtime error. Exiting ...`);
      logger.debug(error);
    }
  }

  public async worker() {
    while (true) {
      try {
        const usedDiskSpace = await du(`./db/${this.name}/`);

        if (usedDiskSpace > this.diskSpace) {
          logger.debug(
            `Reached disk space limit of ${this.diskSpace} - ${(
              (usedDiskSpace * 100) /
              this.diskSpace
            ).toFixed(2)}. Waiting ...`
          );
          await sleep(10 * 1000);
          continue;
        }

        let workerHeight;

        try {
          workerHeight = parseInt((await this.db.get(-1)).toString());
        } catch {
          workerHeight = this.poolState.height.toNumber();
        }

        const ops = await this.requestWorkerBatch(workerHeight);

        await this.db.batch([
          ...ops,
          {
            type: "put",
            key: -1,
            value: Buffer.from((workerHeight + ops.length).toString()),
          },
        ]);
      } catch (error) {
        logger.error("Error fetching data batch", error);
        await sleep(10 * 1000);
      }
    }
  }

  public async requestWorkerBatch(workerHeight: number): Promise<any[]> {
    logger.error(`❌ "requestWorkerBatch" not implemented. Exiting ...`);
    process.exit(1);
  }

  public async createBundle(
    blockInstructions: BlockInstructions
  ): Promise<any[]> {
    logger.error(`❌ "createBundle" not implemented. Exiting ...`);
    process.exit(1);
  }

  public async validate(
    uploadBundle: Buffer[],
    uploadBytes: number,
    downloadBundle: Buffer[],
    downloadBytes: number
  ): Promise<boolean> {
    if (uploadBytes !== downloadBytes) {
      return false;
    }

    if (hash(uploadBundle) !== hash(downloadBundle)) {
      return false;
    }

    return true;
  }

  private async getBlockProposal(): Promise<BlockProposal> {
    const proposal = {
      ...(await this.pool.blockProposal()),
    };

    return {
      uploader: proposal.uploader,
      txId: fromBytes(proposal.txId),
      byteSize: proposal.byteSize.toNumber(),
      fromHeight: proposal.fromHeight.toNumber(),
      toHeight: proposal.toHeight.toNumber(),
      start: proposal.start.toNumber(),
    };
  }

  private async getBlockInstructions(): Promise<BlockInstructions> {
    const instructions = {
      ...(await this.pool.blockInstructions()),
    };

    return {
      uploader: instructions.uploader,
      fromHeight: instructions.fromHeight.toNumber(),
    };
  }

  private async uploadBundleToArweave(
    bundle: Buffer[],
    instructions: BlockInstructions
  ): Promise<Transaction | null> {
    try {
      logger.info("💾 Uploading bundle to Arweave.  ...");

      const transaction = await this.arweave.createTransaction({
        data: formatBundle(bundle),
      });

      logger.debug(`Bundle data size = ${transaction.data_size} Bytes`);
      logger.debug(`Bundle size = ${bundle.length}`);

      transaction.addTag("Application", "KYVE - Testnet");
      transaction.addTag("Pool", this.pool.address);
      transaction.addTag("@kyve/core", version);
      transaction.addTag(this.runtime, this.version);
      transaction.addTag("Uploader", instructions.uploader);
      transaction.addTag("FromHeight", instructions.fromHeight.toString());
      transaction.addTag(
        "ToHeight",
        (instructions.fromHeight + bundle.length).toString()
      );

      await this.arweave.transactions.sign(transaction, this.keyfile);

      const balance = await this.arweave.wallets.getBalance(
        await this.arweave.wallets.getAddress(this.keyfile)
      );

      if (+transaction.reward > +balance) {
        logger.error("❌ You do not have enough funds in your Arweave wallet.");
        process.exit(1);
      }

      await this.arweave.transactions.post(transaction);

      return transaction;
    } catch (error) {
      logger.error(
        "❌ Received an error while trying to upload bundle to Arweave. Skipping upload ..."
      );
      logger.debug(error);
      return null;
    }
  }

  private async submitBlockProposal(
    transaction: Transaction,
    bundleSize: number
  ) {
    try {
      const tx = await this.pool.submitBlockProposal(
        toBytes(transaction.id),
        +transaction.data_size,
        bundleSize,
        {
          gasLimit: ethers.BigNumber.from(1000000),
          gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
        }
      );

      logger.debug(`Submitting block proposal ${transaction.id} ...`);
      logger.debug(`Transaction = ${tx.hash}`);
    } catch (error) {
      logger.error(
        "❌ Received an error while submitting block proposal. Skipping submit ..."
      );
      logger.debug(error);
    }
  }

  private async waitForNextBlockInstructions(
    blockInstructions: BlockInstructions
  ): Promise<void> {
    return new Promise((resolve) => {
      logger.debug("Waiting for next block instructions ...");

      const uploadTimeout = setTimeout(async () => {
        try {
          if (blockInstructions?.uploader !== this.wallet.address) {
            logger.debug("Reached upload timeout. Claiming uploader role ...");
            const tx = await this.pool.claimUploaderRole({
              gasLimit: await this.pool.estimateGas.claimUploaderRole(),
              gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
            });
            logger.debug(`Transaction = ${tx.hash}`);
          }
        } catch (error) {
          logger.error(
            "❌ Received an error while claiming uploader slot. Skipping claim ..."
          );
          logger.debug(error);
        }
      }, this.poolState.uploadTimeout.toNumber() * 1000);

      this.pool.on("NextBlockInstructions", () => {
        clearTimeout(uploadTimeout);
        resolve();
      });
    });
  }

  private async vote(vote: { transaction: string; valid: boolean }) {
    logger.info(
      `🖋  Voting ${vote.valid ? "valid" : "invalid"} on bundle ${
        vote.transaction
      } ...`
    );

    const canVote: boolean = await this.pool.canVote(this.wallet.address);
    if (!canVote) {
      logger.info(
        "⚠️  Node has no voting power because it has no delegators. Skipping vote ..."
      );
      return;
    }

    try {
      const tx = await this.pool.vote(toBytes(vote.transaction), vote.valid, {
        gasLimit: await this.pool.estimateGas.vote(
          toBytes(vote.transaction),
          vote.valid
        ),
        gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
      });
      logger.debug(`Transaction = ${tx.hash}`);
    } catch (error) {
      logger.error(
        "❌ Received an error while trying to vote. Skipping vote ..."
      );
      logger.debug(error);
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

  private setupMetrics() {
    if (this.runMetrics) {
      logger.info(
        "🔬 Starting metric server on: http://localhost:8080/metrics"
      );

      // HTTP server which exposes the metrics on http://localhost:8080/metrics
      http
        .createServer(async (req: any, res: any) => {
          // Retrieve route from request object
          const route = url.parse(req.url).pathname;

          if (route === "/metrics") {
            // Return all metrics the Prometheus exposition format
            res.setHeader("Content-Type", register.contentType);
            const defaultMetrics = await register.metrics();
            const other = await KYVE.metrics.register.metrics();
            res.end(defaultMetrics + "\n" + other);
          }
        })
        .listen(8080);
    }
  }

  private async fetchPoolState() {
    logger.debug("Attempting to fetch pool state.");

    try {
      this.poolState = { ...(await this.pool.pool()) };
    } catch (error) {
      logger.error(
        "❌ Received an error while trying to fetch the pool state:",
        error
      );
      process.exit(1);
    }

    try {
      this.poolState.config = JSON.parse(this.poolState.config);
    } catch (error) {
      logger.error(
        "❌ Received an error while trying to parse the config:",
        error
      );
      process.exit(1);
    }

    try {
      this.poolState.metadata = JSON.parse(this.poolState.metadata);
    } catch (error) {
      logger.error(
        "❌ Received an error while trying to parse the metadata:",
        error
      );
      process.exit(1);
    }

    try {
      if (
        satisfies(
          this.version,
          this.poolState.metadata?.versions || this.version
        )
      ) {
        logger.info("⏱  Pool version requirements met.");
      } else {
        logger.error(
          `❌ Running an invalid version for the specified pool. Version requirements are ${this.poolState.metadata.versions}.`
        );
        process.exit(1);
      }
    } catch (error) {
      logger.error("❌ Received an error while trying parse versions");
      logger.debug(error);
      process.exit(1);
    }

    if (this.poolState.metadata?.runtime === this.runtime) {
      logger.info(`💻 Running node on runtime ${this.runtime}.`);
    } else {
      logger.error("❌ Specified pool does not match the integration runtime.");
      process.exit(1);
    }

    logger.info("ℹ Fetched pool state.");
  }

  private async setupDB() {
    if (!existsSync("./db")) {
      mkdirSync("./db");
    }

    this.db = level(`./db/${this.name}`, {
      valueEncoding: "binary",
    });
  }

  private async checkIfNodeIsValidator() {
    try {
      const isValidator = await this.pool.isValidator(this.wallet.address);

      if (isValidator) {
        logger.info("🔍  Node is running as a validator.");
      } else {
        logger.error("❌ Node is no active validator. Exiting ...");
        process.exit(1);
      }
    } catch (error) {
      logger.error("❌ Received an error while trying to fetch validator info");
      logger.debug(error);
      process.exit(1);
    }
  }

  private async setupNodeStake() {
    let parsedStake;

    logger.info("🌐 Joining KYVE Network ...");

    let nodeStake = toBN(
      (await this.pool.nodeState(this.wallet.address)).personalStake
    );

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

    if (parsedStake.lt(toBN(this.poolState.minStake))) {
      logger.error(
        `❌ Desired stake is lower than the minimum stake. Desired Stake = ${toHumanReadable(
          parsedStake
        )}, Minimum Stake = ${toHumanReadable(toBN(this.poolState.minStake))}`
      );
      process.exit();
    }

    if (parsedStake.gt(nodeStake)) {
      // Stake the difference.
      const diff = parsedStake.minus(nodeStake);
      await this.selfStake(diff);
    } else if (parsedStake.lt(nodeStake)) {
      // Unstake the difference.
      const diff = nodeStake.minus(parsedStake);
      await this.selfUnstake(diff);
    } else {
      logger.info("👌 Already staked with the correct amount.");
    }
  }

  private async selfStake(amount: BigNumber) {
    const token = await getTokenContract(this.pool);
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

      tx = await this.pool.stake(toEthersBN(amount), {
        gasLimit: await this.pool.estimateGas.stake(toEthersBN(amount)),
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

  private async selfUnstake(amount: BigNumber) {
    let tx: ContractTransaction;

    try {
      tx = await this.pool.unstake(toEthersBN(amount), {
        gasLimit: await this.pool.estimateGas.unstake(toEthersBN(amount)),
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

  private async setupNodeCommission() {
    let parsedCommission;

    logger.info("👥 Setting node commission ...");

    let nodeCommission = toBN(
      (await this.pool.nodeState(this.wallet.address)).commission
    );

    try {
      parsedCommission = new BigNumber(this.commission).multipliedBy(
        new BigNumber(10).exponentiatedBy(18)
      );

      if (parsedCommission.lt(0) && parsedCommission.gt(100)) {
        logger.error("❌ Desired commission must be between 0 and 100.");
        process.exit(1);
      }
    } catch (error) {
      logger.error("❌ Provided invalid commission amount:", error);
      process.exit(1);
    }

    if (!parsedCommission.eq(nodeCommission)) {
      try {
        const tx = await this.pool.updateCommission(
          toEthersBN(parsedCommission),
          {
            gasLimit: await this.pool.estimateGas.updateCommission(
              toEthersBN(parsedCommission)
            ),
            gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
          }
        );
        logger.debug(`Updating commission. Transaction = ${tx.hash}`);

        await tx.wait();
        logger.info("💼 Successfully updated commission.");
      } catch (error) {
        logger.error(
          "❌ Received an error while trying to update commission:",
          error
        );
        process.exit(1);
      }
    } else {
      logger.info("👌 Already set correct commission.");
    }
  }

  // TODO: move to separate file
  private calculateUploaderWaitingTime() {
    const waitingTime = Math.log2(this.poolState.bundleSize) * 5;
    if (waitingTime > 30) return waitingTime * 1000;
    return 30 * 1000;
  }

  // TODO: move to separate file
  private generateRandomName() {
    const r = new Prando(this.wallet.address + this.pool.address);

    return uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: "-",
      length: 3,
      style: "lowerCase",
      seed: r.nextInt(0, adjectives.length * colors.length * animals.length),
    }).replace(" ", "-");
  }
}

export default KYVE;
