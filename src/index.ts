import Arweave from "arweave";
import { JWKInterface } from "arweave/node/lib/wallet";
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
import { Bundle, BundleInstructions, BundleProposal } from "./faces";
import { CLI } from "./utils";
import { sleep, toBytes } from "./utils/helpers";
import { logger } from "./utils";
import { version } from "../package.json";
import hash from "object-hash";
import http from "http";
import url from "url";
import client, { register } from "prom-client";
import { Database } from "./utils/database";
import du from "du";
import { gzipSync } from "zlib";
import axios from "axios";
import {
  Secp256k1HdWallet,
  SigningCosmosClient,
  coins,
} from "@cosmjs/launchpad";

export * from "./utils";
export * from "./faces";
export * from "./utils/helpers";
export * from "./utils/database";
export * from "./utils/progress";

client.collectDefaultMetrics({
  labels: { app: "kyve-core" },
});

const metricsWorkerHeight = new client.Gauge({
  name: "current_worker_height",
  help: "The current height the worker has indexed to.",
});

const metricsDbSize = new client.Gauge({
  name: "current_db_size",
  help: "The size of the local database.",
});

const metricsDbUsed = new client.Gauge({
  name: "current_db_used",
  help: "The database usage in percent.",
});

class KYVE {
  protected poolId: number;
  protected pool: any;
  protected runtime: string;
  protected version: string;
  protected commission: string;
  protected mnemonic: string;
  protected keyfile: JWKInterface;
  protected endpoint: string;
  protected name: string;
  protected gasMultiplier: string;
  protected runMetrics: boolean;
  protected space: number;
  protected db: Database;
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

    this.poolId = options.poolId;
    this.runtime = cli.runtime;
    this.version = cli.packageVersion;
    this.commission = options.commission;
    this.mnemonic = options.mnemonic;
    this.keyfile = JSON.parse(readFileSync(options.keyfile, "utf-8"));
    this.endpoint = options.endpoint || "http://0.0.0.0:1317";
    this.gasMultiplier = options.gasMultiplier;
    this.runMetrics = options.metrics;
    this.space = +options.space;
    this.name = options?.name ?? this.generateRandomName();

    this.db = new Database(this.name);

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
    await this.logNodeInfo();
    this.setupMetrics();

    try {
      await this.getPool();
    } catch {
      process.exit(1);
    }

    // await this.setupNodeCommission();

    try {
      await this.verifyNode();
    } catch {
      process.exit(1);
    }

    this.worker();
    this.run();
  }

  private async run() {
    try {
      while (true) {
        logger.info("\n⚡️ Starting new proposal");

        try {
          await this.getPool(false);
        } catch {
          await sleep(60 * 1000);
          continue;
        }

        if (this.pool.paused) {
          logger.info("💤  Pool is paused. Waiting ...");
          await sleep(60 * 1000);
          continue;
        }

        try {
          await this.verifyNode(false);
        } catch {
          await sleep(60 * 1000);
          continue;
        }

        await this.clearFinalizedData();

        if (
          this.pool.bundleProposal.nextUploader === (await this.getAddress())
        ) {
          logger.info("📚 Selected as UPLOADER");
        } else {
          logger.info("🧐 Selected as VALIDATOR");
        }

        if (
          this.pool.bundleProposal.uploader &&
          this.pool.bundleProposal.uploader !== (await this.getAddress())
        ) {
          const { data: canVote } = await axios.get(
            `${this.endpoint}/kyve/registry/can_vote/${
              this.poolId
            }/${await this.getAddress()}?bundleId=${
              this.pool.bundleProposal.bundleId
            }`
          );

          if (canVote.possible) {
            await this.validateProposal();
            await this.getPool(false);
          } else {
            logger.debug(`Can not vote this round: Reason: ${canVote.reason}`);
          }
        }

        if (!this.pool.bundleProposal.nextUploader) {
          await this.claimUploaderRole();
          await this.getPool(false);
        }

        if (
          this.pool.bundleProposal.nextUploader === (await this.getAddress())
        ) {
          logger.debug("Waiting for proposal quorum ...");
        }

        while (true) {
          await this.getPool(false);

          if (
            this.pool.bundleProposal.nextUploader === (await this.getAddress())
          ) {
            const { data: canPropose } = await axios.get(
              `${this.endpoint}/kyve/registry/can_propose/${
                this.poolId
              }/${await this.getAddress()}`
            );

            if (canPropose.possible) {
              // if upload fails try again & refetch bundleProposal
              await this.uploadBundleToArweave();
              break;
            } else {
              logger.debug(`Can not propose: ${canPropose.reason}`);
              await sleep(10 * 1000);
            }
          } else {
            break;
          }
        }

        await this.nextBundleInstructions();
      }
    } catch (error) {
      logger.error(`❌ Runtime error. Exiting ...`);
      logger.debug(error);
    }
  }

  public async worker() {
    while (true) {
      try {
        let workerHeight;

        try {
          workerHeight = parseInt(await this.db.get("head"));
        } catch {
          workerHeight = parseInt(this.pool.heightArchived);
        }

        const usedDiskSpace = await du(`./db/${this.name}/`);
        const usedDiskSpacePercent = parseFloat(
          ((usedDiskSpace * 100) / this.space).toFixed(2)
        );

        metricsWorkerHeight.set(workerHeight);
        metricsDbSize.set(usedDiskSpace);
        metricsDbUsed.set(usedDiskSpacePercent);

        if (usedDiskSpace > this.space) {
          logger.debug(`Used disk space: ${usedDiskSpacePercent}%`);
          await sleep(60 * 1000);
          continue;
        }

        const ops = await this.requestWorkerBatch(workerHeight);

        for (let op of ops) {
          await this.db.put(op.key, op.value);
        }

        await this.db.put("head", workerHeight + ops.length);
      } catch (error) {
        logger.error("❌ Error requesting data batch.");
        logger.debug(error);
        await sleep(10 * 1000);
      }
    }
  }

  public async requestWorkerBatch(workerHeight: number): Promise<any[]> {
    logger.error(`❌ "requestWorkerBatch" not implemented. Exiting ...`);
    process.exit(1);
  }

  public async createBundle(
    bundleInstructions: BundleInstructions
  ): Promise<Bundle> {
    logger.error(`❌ "createBundle" not implemented. Exiting ...`);
    process.exit(1);
  }

  public async loadBundle(bundleProposal: BundleProposal): Promise<Buffer> {
    logger.error(`❌ "loadBundle" not implemented. Exiting ...`);
    process.exit(1);
  }

  private async clearFinalizedData() {
    let tail: number;

    try {
      tail = parseInt(await this.db.get("tail"));
    } catch {
      tail = parseInt(this.pool.heightArchived);
    }

    for (let key = tail; key < parseInt(this.pool.heightArchived); key++) {
      await this.db.del(key);
    }

    await this.db.put("tail", parseInt(this.pool.heightArchived));
  }

  private async validateProposal() {
    logger.info(`🔬 Validating bundle ${this.pool.bundleProposal.bundleId}`);
    logger.debug(`Downloading bundle from Arweave ...`);

    let uploadBundle;
    let downloadBundle;

    while (true) {
      downloadBundle = await this.downloadBundleFromArweave();

      if (downloadBundle) {
        logger.debug(
          `Loading local bundle from ${this.pool.bundleProposal.fromHeight} to ${this.pool.bundleProposal.toHeight} ...`
        );

        uploadBundle = gzipSync(
          await this.loadBundle(this.pool.bundleProposal)
        );

        await this.vote({
          transaction: this.pool.bundleProposal.bundleId,
          valid: await this.validate(
            uploadBundle,
            +this.pool.bundleProposal.byteSize,
            downloadBundle,
            +downloadBundle.byteLength
          ),
        });
        break;
      } else {
        logger.error(
          `❌ Error fetching bundle from Arweave. Retrying in 30s ...`
        );
        await sleep(30 * 1000);
      }
    }
  }

  public async validate(
    uploadBundle: Buffer,
    uploadBytes: number,
    downloadBundle: Buffer,
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

  private async downloadBundleFromArweave(): Promise<any> {
    try {
      const { status } = await this.arweave.transactions.getStatus(
        this.pool.bundleProposal.bundleId
      );

      if (status === 200 || status === 202) {
        const { data: downloadBundle } = await axios.get(
          `https://arweave.net/${this.pool.bundleProposal.bundleId}`,
          { responseType: "arraybuffer" }
        );

        return downloadBundle;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async uploadBundleToArweave(): Promise<void> {
    try {
      logger.info("📦 Creating new bundle proposal");

      const uploadBundle = await this.createBundle(this.pool.bundleProposal);

      logger.debug("Uploading bundle to Arweave ...");

      const transaction = await this.arweave.createTransaction({
        data: gzipSync(uploadBundle.bundle),
      });

      logger.debug(
        `Bundle details = bytes: ${transaction.data_size}, items: ${
          uploadBundle.toHeight - uploadBundle.fromHeight
        }`
      );

      transaction.addTag("Application", "KYVE - Testnet");
      transaction.addTag("Pool", this.pool.toString());
      transaction.addTag("@kyve/core", version);
      transaction.addTag(this.runtime, this.version);
      transaction.addTag("Uploader", this.pool.bundleProposal.nextUploader);
      transaction.addTag("FromHeight", uploadBundle.fromHeight.toString());
      transaction.addTag("ToHeight", uploadBundle.toHeight.toString());
      transaction.addTag("Content-Type", "application/gzip");

      await this.arweave.transactions.sign(transaction, this.keyfile);

      const balance = await this.arweave.wallets.getBalance(
        await this.arweave.wallets.getAddress(this.keyfile)
      );

      if (+transaction.reward > +balance) {
        logger.error("❌ You do not have enough funds in your Arweave wallet.");
        process.exit(1);
      }

      await this.arweave.transactions.post(transaction);

      const tx = await this.pool.submitBundleProposal(
        toBytes(transaction.id),
        +transaction.data_size,
        uploadBundle.toHeight - uploadBundle.fromHeight
      );

      logger.debug(`Arweave Transaction ${transaction.id} ...`);
      logger.debug(`Transaction = ${tx.hash}`);
    } catch (error) {
      logger.error(
        "❌ Received an error while trying to upload bundle to Arweave. Skipping upload ..."
      );
      logger.debug(error);
    }
  }

  private async claimUploaderRole() {
    try {
      logger.info("🔍 Claiming uploader role ...");

      const client = await this.getClient();
      const receipt = await client.signAndBroadcast(
        [
          {
            type: "/KYVENetwork.kyve.registry.MsgClaimUploaderRole",
            value: {},
          },
        ],
        {
          amount: coins(0, "kyve"),
          gas: "200000",
        }
      );

      logger.debug(`Transaction = ${receipt.transactionHash}`);
    } catch (error) {
      logger.error(
        "❌ Received an error while to claim uploader role. Skipping ..."
      );
      logger.debug(error);
    }
  }

  private async nextBundleInstructions(): Promise<void> {
    return new Promise((resolve) => {
      logger.debug("Waiting for new proposal ...");

      const uploadTimeout = setInterval(async () => {
        try {
          if (
            this.pool.bundleProposal.nextUploader !== (await this.getAddress())
          ) {
            if (await this.pool.canClaim()) {
              await this.claimUploaderRole();
            }
          }
        } catch (error) {
          logger.error(
            "❌ Received an error while claiming uploader role. Skipping claim ..."
          );
          logger.debug(error);
        }
      }, 10 * 1000);

      this.pool.on("NextBundleInstructions", () => {
        clearInterval(uploadTimeout);
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

    try {
      const tx = await this.pool.vote(toBytes(vote.transaction), vote.valid, {
        gasLimit: await this.pool.estimateGas.vote(
          toBytes(vote.transaction),
          vote.valid
        ),
      });
      logger.debug(`Transaction = ${tx.hash}`);
    } catch (error) {
      logger.error("❌ Received an error while trying to vote. Skipping ...");
      logger.debug(error);
    }
  }

  private async logNodeInfo() {
    const formatInfoLogs = (input: string) => {
      const length = Math.max(13, this.runtime.length);
      return input.padEnd(length, " ");
    };

    logger.info(
      `🚀 Starting node ...\n\t${formatInfoLogs("Node name")} = ${
        this.name
      }\n\t${formatInfoLogs(
        "Address"
      )} = ${await this.getAddress()}\n\t${formatInfoLogs("Pool Id")} = ${
        this.poolId
      }\n\t${formatInfoLogs("@kyve/core")} = v${version}\n\t${formatInfoLogs(
        this.runtime
      )} = v${this.version}`
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

  private async getPool(logs: boolean = true) {
    if (logs) {
      logger.debug("Attempting to fetch pool state.");
    }

    try {
      const {
        data: { Pool },
      } = await axios.get(`${this.endpoint}/kyve/registry/pool/${this.poolId}`);
      this.pool = { ...Pool };
    } catch (error) {
      logger.error(
        "❌ Received an error while trying to fetch the pool state:"
      );
      logger.debug(error);
      throw new Error();
    }

    try {
      this.pool.metadata = JSON.parse(this.pool.metadata);
    } catch (error) {
      logger.error("❌ Received an error while trying to parse the metadata:");
      logger.debug(error);
      throw new Error();
    }

    if (this.pool.metadata?.runtime === this.runtime) {
      if (logs) {
        logger.info(`💻 Running node on runtime ${this.runtime}.`);
      }
    } else {
      logger.error("❌ Specified pool does not match the integration runtime.");
      process.exit(1);
    }

    try {
      if (
        satisfies(this.version, this.pool.metadata?.versions || this.version)
      ) {
        if (logs) {
          logger.info("⏱  Pool version requirements met.");
        }
      } else {
        logger.error(
          `❌ Running an invalid version for the specified pool. Version requirements are ${this.pool.metadata.versions}.`
        );
        process.exit(1);
      }
    } catch (error) {
      logger.error("❌ Received an error while trying parse versions");
      logger.debug(error);
      process.exit(1);
    }

    if (logs) {
      logger.info("✅ Fetched pool state");
    }
  }

  private async verifyNode(logs: boolean = true) {
    try {
      const isStaker = !!this.pool.stakers[await this.getAddress()];

      if (isStaker) {
        if (logs) {
          logger.info("🔍  Node is running as a validator.");
        }
      } else {
        logger.error("❌ Node is no active validator. Exiting ...");
        process.exit(1);
      }
    } catch (error) {
      logger.error("❌ Received an error while trying to fetch validator info");
      logger.debug(error);
      throw new Error();
    }
  }

  // private async setupNodeCommission() {
  //   let parsedCommission;

  //   logger.info("👥 Setting node commission ...");

  //   let nodeCommission = toBN(
  //     (await this.pool.nodeState(this.wallet.address)).commission
  //   );

  //   try {
  //     parsedCommission = new BigNumber(this.commission).multipliedBy(
  //       new BigNumber(10).exponentiatedBy(18)
  //     );

  //     if (parsedCommission.lt(0) && parsedCommission.gt(100)) {
  //       logger.error("❌ Desired commission must be between 0 and 100.");
  //       process.exit(1);
  //     }
  //   } catch (error) {
  //     logger.error("❌ Provided invalid commission amount:", error);
  //     process.exit(1);
  //   }

  //   if (!parsedCommission.eq(nodeCommission)) {
  //     try {
  //       const tx = await this.pool.updateCommission(
  //         toEthersBN(parsedCommission),
  //         {
  //           gasLimit: await this.pool.estimateGas.updateCommission(
  //             toEthersBN(parsedCommission)
  //           ),
  //           gasPrice: await getGasPrice(this.pool, this.gasMultiplier),
  //         }
  //       );
  //       logger.debug(`Updating commission. Transaction = ${tx.hash}`);

  //       await tx.wait();
  //       logger.info("💼 Successfully updated commission.");
  //     } catch (error) {
  //       logger.error(
  //         "❌ Received an error while trying to update commission:",
  //         error
  //       );
  //       process.exit(1);
  //     }
  //   } else {
  //     logger.info("👌 Already set correct commission.");
  //   }
  // }

  private async getWallet() {
    return await Secp256k1HdWallet.fromMnemonic(this.mnemonic, {
      prefix: "kyve",
    });
  }

  private async getAddress() {
    const [{ address }] = await (await this.getWallet()).getAccounts();
    return address;
  }

  private async getBalance() {
    const address = await this.getAddress();

    const { data } = await axios.get(
      `${this.endpoint}/bank/balances/${address}`
    );

    const coin = data.result.find(
      (coin: { denom: string; amount: string }) => coin.denom === "kyve"
    );

    return coin ? coin.amount : "0";
  }

  private async getClient() {
    return new SigningCosmosClient(
      this.endpoint,
      await this.getAddress(),
      await this.getWallet()
    );
  }

  // TODO: move to separate file
  private generateRandomName() {
    const r = new Prando(this.mnemonic + this.pool);

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
