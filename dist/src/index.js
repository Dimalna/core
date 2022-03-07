"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const arweave_1 = __importDefault(require("arweave"));
const fs_1 = require("fs");
const prando_1 = __importDefault(require("prando"));
const semver_1 = require("semver");
const utils_1 = require("./utils");
const helpers_1 = require("./utils/helpers");
const utils_2 = require("./utils");
const package_json_1 = require("../package.json");
const object_hash_1 = __importDefault(require("object-hash"));
const http_1 = __importDefault(require("http"));
const url_1 = __importDefault(require("url"));
const prom_client_1 = __importStar(require("prom-client"));
const database_1 = require("./utils/database");
const client_1 = require("./utils/client");
const du_1 = __importDefault(require("du"));
const zlib_1 = require("zlib");
const axios_1 = __importDefault(require("axios"));
const object_sizeof_1 = __importDefault(require("object-sizeof"));
const unique_names_generator_1 = require("unique-names-generator");
__exportStar(require("./utils"), exports);
__exportStar(require("./faces"), exports);
__exportStar(require("./utils/helpers"), exports);
__exportStar(require("./utils/database"), exports);
prom_client_1.default.collectDefaultMetrics({
    labels: { app: "kyve-core" },
});
const metricsCacheHeight = new prom_client_1.default.Gauge({
    name: "current_cache_height",
    help: "The current height the cache has indexed to.",
});
const metricsDbSize = new prom_client_1.default.Gauge({
    name: "current_db_size",
    help: "The size of the local database.",
});
const metricsDbUsed = new prom_client_1.default.Gauge({
    name: "current_db_used",
    help: "The database usage in percent.",
});
class KYVE {
    constructor(cli) {
        var _a;
        this.arweave = new arweave_1.default({
            host: "arweave.net",
            protocol: "https",
        });
        if (!cli) {
            cli = new utils_1.CLI(process.env.KYVE_RUNTIME, process.env.KYVE_VERSION);
        }
        cli.parse();
        const options = cli.opts();
        this.poolId = options.poolId;
        this.runtime = cli.runtime;
        this.version = cli.packageVersion;
        this.commission = options.commission;
        this.client = new client_1.Client(options.mnemonic);
        this.keyfile = JSON.parse((0, fs_1.readFileSync)(options.keyfile, "utf-8"));
        this.gasMultiplier = options.gasMultiplier;
        this.runMetrics = options.metrics;
        this.space = +options.space;
        this.name = (_a = options === null || options === void 0 ? void 0 : options.name) !== null && _a !== void 0 ? _a : this.generateRandomName(options.mnemonic);
        this.db = new database_1.Database(this.name);
        if (!(0, fs_1.existsSync)("./logs")) {
            (0, fs_1.mkdirSync)("./logs");
        }
        const logToTransport = (log) => {
            (0, fs_1.appendFileSync)(`./logs/${this.name}.txt`, JSON.stringify(log) + "\n");
        };
        utils_2.logger.setSettings({
            minLevel: options.verbose ? undefined : "info",
        });
        utils_2.logger.attachTransport({
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
        await this.getPool();
        await this.verifyNode();
        this.cache();
        this.logger();
        this.run();
    }
    async run() {
        try {
            const address = await this.client.getAddress();
            while (true) {
                console.log("");
                utils_2.logger.info("⚡️ Starting new proposal");
                // get current pool state
                await this.getPool(false);
                // save height of bundle proposal
                const createdAt = this.pool.bundleProposal.createdAt;
                // TODO: maybe move to getPool()
                if (this.pool.paused) {
                    utils_2.logger.info("💤  Pool is paused. Waiting ...");
                    await (0, helpers_1.sleep)(60 * 1000);
                    continue;
                }
                await this.verifyNode(false);
                await this.clearFinalizedData();
                if (this.pool.bundleProposal.nextUploader === address) {
                    utils_2.logger.info("📚 Selected as UPLOADER");
                }
                else {
                    utils_2.logger.info("🧐 Selected as VALIDATOR");
                }
                if (this.pool.bundleProposal.uploader &&
                    this.pool.bundleProposal.uploader !== address) {
                    let canVote = {
                        possible: false,
                        reason: "Failed to execute canVote query",
                    };
                    try {
                        const { data } = await axios_1.default.get(`${this.client.endpoints.rest}/kyve/registry/can_vote/${this.poolId}/${await this.client.getAddress()}?bundleId=${this.pool.bundleProposal.bundleId}`);
                        canVote = data;
                    }
                    catch { }
                    if (canVote.possible) {
                        await this.validateProposal(createdAt);
                        await this.getPool(false);
                    }
                    else {
                        utils_2.logger.debug(`Can not vote this round: Reason: ${canVote.reason}`);
                    }
                }
                // check if new proposal is available in the meantime
                if (+this.pool.bundleProposal.createdAt > +createdAt) {
                    continue;
                }
                if (!this.pool.bundleProposal.nextUploader) {
                    await this.claimUploaderRole();
                    await this.getPool(false);
                }
                if (this.pool.bundleProposal.nextUploader === address) {
                    utils_2.logger.debug("Waiting for proposal quorum ...");
                }
                while (true) {
                    await this.getPool(false);
                    // check if new proposal is available in the meantime
                    if (+this.pool.bundleProposal.createdAt > +createdAt) {
                        break;
                    }
                    if (this.pool.bundleProposal.nextUploader === address) {
                        let canPropose = {
                            possible: false,
                            reason: "Failed to execute canPropose query",
                        };
                        try {
                            const { data } = await axios_1.default.get(`${this.client.endpoints.rest}/kyve/registry/can_propose/${this.poolId}/${await this.client.getAddress()}`);
                            canPropose = data;
                        }
                        catch { }
                        if (canPropose.possible) {
                            // if upload fails try again & refetch bundleProposal
                            await this.uploadBundleToArweave();
                            break;
                        }
                        else {
                            utils_2.logger.debug(`Can not propose: ${canPropose.reason}. Retrying in 10s ...`);
                            await (0, helpers_1.sleep)(10 * 1000);
                        }
                    }
                    else {
                        await this.nextBundleProposal(createdAt);
                        break;
                    }
                }
                utils_2.logger.debug(`Proposal ended`);
            }
        }
        catch (error) {
            utils_2.logger.error(`❌ Runtime error. Exiting ...`);
            utils_2.logger.debug(error);
            process.exit(1);
        }
    }
    async logger() {
        setInterval(async () => {
            let height;
            try {
                height = parseInt(await this.db.get("head"));
            }
            catch {
                height = parseInt(this.pool.heightArchived);
            }
            utils_2.logger.debug(`Cached to height = ${height}`);
        }, 60 * 1000);
    }
    async cache() {
        while (true) {
            let height = 0;
            try {
                try {
                    height = parseInt(await this.db.get("head"));
                }
                catch {
                    height = parseInt(this.pool.heightArchived);
                }
                const usedDiskSpace = await (0, du_1.default)(`./db/${this.name}/`);
                const usedDiskSpacePercent = parseFloat(((usedDiskSpace * 100) / this.space).toFixed(2));
                metricsCacheHeight.set(height);
                metricsDbSize.set(usedDiskSpace);
                metricsDbUsed.set(usedDiskSpacePercent);
                if (usedDiskSpace > this.space) {
                    utils_2.logger.debug(`Used disk space: ${usedDiskSpacePercent}%`);
                    await (0, helpers_1.sleep)(60 * 1000);
                    continue;
                }
                const batch = [];
                const batchSize = 10;
                const targetHeight = height + batchSize;
                for (let h = height; h < targetHeight; h++) {
                    batch.push(this.getDataItemAndSave(h));
                }
                await Promise.all(batch);
                await this.db.put("head", targetHeight);
            }
            catch (error) {
                utils_2.logger.error(`❌ Error requesting data item at height = ${height}`);
                utils_2.logger.debug(error);
                await (0, helpers_1.sleep)(10 * 1000);
            }
        }
    }
    async getDataItem(height) {
        utils_2.logger.error(`❌ "getDataItem" not implemented. Exiting ...`);
        process.exit(1);
    }
    async getDataItemAndSave(height) {
        try {
            const dataItem = await this.getDataItem(height);
            await this.db.put(height, dataItem);
        }
        catch (error) {
            utils_2.logger.error(`❌ Error requesting data item ...`);
            utils_2.logger.debug(error);
        }
    }
    async createBundle() {
        const bundleDataSizeLimit = 20 * 1000 * 1000; // 20 MB
        const bundleItemSizeLimit = 10000;
        const bundle = [];
        let currentDataSize = 0;
        let h = +this.pool.bundleProposal.toHeight;
        while (true) {
            try {
                const dataItem = await this.db.get(h);
                const entry = {
                    key: h,
                    value: dataItem,
                };
                currentDataSize += (0, object_sizeof_1.default)(entry);
                if (currentDataSize < bundleDataSizeLimit &&
                    bundle.length < bundleItemSizeLimit) {
                    bundle.push(entry);
                    h++;
                }
                else {
                    break;
                }
            }
            catch {
                if (bundle.length < +this.pool.minBundleSize) {
                    await (0, helpers_1.sleep)(10 * 1000);
                }
                else {
                    break;
                }
            }
        }
        return {
            fromHeight: this.pool.bundleProposal.toHeight,
            toHeight: h,
            bundle,
        };
    }
    async loadBundle() {
        const bundle = [];
        let h = +this.pool.bundleProposal.fromHeight;
        while (h < +this.pool.bundleProposal.toHeight) {
            try {
                const dataItem = await this.db.get(h);
                const encodedDataItem = Buffer.from(JSON.stringify(dataItem));
                bundle.push(encodedDataItem);
                h++;
            }
            catch {
                await (0, helpers_1.sleep)(10 * 1000);
            }
        }
        return (0, helpers_1.formatBundle)(bundle);
    }
    async clearFinalizedData() {
        let tail;
        try {
            tail = parseInt(await this.db.get("tail"));
        }
        catch {
            tail = parseInt(this.pool.heightArchived);
        }
        for (let key = tail; key < parseInt(this.pool.heightArchived); key++) {
            try {
                await this.db.del(key);
            }
            catch (error) {
                utils_2.logger.error(`❌ Error clearing old bundle data with key ${key}:`);
                utils_2.logger.debug(error);
            }
        }
        await this.db.put("tail", parseInt(this.pool.heightArchived));
    }
    async validateProposal(createdAt) {
        utils_2.logger.info(`🔬 Validating bundle ${this.pool.bundleProposal.bundleId}`);
        utils_2.logger.debug(`Downloading bundle from Arweave ...`);
        let uploadBundle;
        let downloadBundle;
        // try to fetch bundle
        while (true) {
            await this.getPool(false);
            // check if new proposal is available in the meantime
            if (+this.pool.bundleProposal.createdAt > +createdAt) {
                break;
            }
            downloadBundle = await this.downloadBundleFromArweave();
            if (downloadBundle) {
                utils_2.logger.debug(`Successfully downloaded bundle from Arweave`);
                utils_2.logger.debug(`Loading local bundle from ${this.pool.bundleProposal.fromHeight} to ${this.pool.bundleProposal.toHeight} ...`);
                uploadBundle = (0, zlib_1.gzipSync)(await this.loadBundle());
                await this.vote({
                    transaction: this.pool.bundleProposal.bundleId,
                    valid: await this.validate(uploadBundle, +this.pool.bundleProposal.byteSize, downloadBundle, +downloadBundle.byteLength),
                });
                break;
            }
            else {
                utils_2.logger.error(`❌ Error fetching bundle from Arweave. Retrying in 30s ...`);
                await (0, helpers_1.sleep)(30 * 1000);
            }
        }
    }
    async validate(uploadBundle, uploadBytes, downloadBundle, downloadBytes) {
        if (uploadBytes !== downloadBytes) {
            return false;
        }
        if ((0, object_hash_1.default)(uploadBundle) !== (0, object_hash_1.default)(downloadBundle)) {
            return false;
        }
        return true;
    }
    async downloadBundleFromArweave() {
        try {
            const { status } = await this.arweave.transactions.getStatus(this.pool.bundleProposal.bundleId);
            if (status === 200 || status === 202) {
                const { data: downloadBundle } = await axios_1.default.get(`https://arweave.net/${this.pool.bundleProposal.bundleId}`, { responseType: "arraybuffer" });
                return downloadBundle;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    async uploadBundleToArweave() {
        try {
            utils_2.logger.info("📦 Creating new bundle proposal");
            utils_2.logger.debug(`Creating bundle from height = ${this.pool.bundleProposal.toHeight} ...`);
            const uploadBundle = await this.createBundle();
            utils_2.logger.debug("Uploading bundle to Arweave ...");
            const transaction = await this.arweave.createTransaction({
                data: (0, zlib_1.gzipSync)(JSON.stringify(uploadBundle.bundle)),
            });
            utils_2.logger.debug(`Bundle details = bytes: ${transaction.data_size}, items: ${uploadBundle.toHeight - uploadBundle.fromHeight}`);
            transaction.addTag("Application", "KYVE - Testnet");
            transaction.addTag("Pool", this.poolId.toString());
            transaction.addTag("@kyve/core", package_json_1.version);
            transaction.addTag(this.runtime, this.version);
            transaction.addTag("Uploader", this.pool.bundleProposal.nextUploader);
            transaction.addTag("FromHeight", uploadBundle.fromHeight.toString());
            transaction.addTag("ToHeight", uploadBundle.toHeight.toString());
            transaction.addTag("Content-Type", "application/gzip");
            await this.arweave.transactions.sign(transaction, this.keyfile);
            const balance = await this.arweave.wallets.getBalance(await this.arweave.wallets.getAddress(this.keyfile));
            if (+transaction.reward > +balance) {
                utils_2.logger.error("❌ You do not have enough funds in your Arweave wallet.");
                process.exit(1);
            }
            await this.arweave.transactions.post(transaction);
            const tx = await this.client.sendMessage({
                typeUrl: "/KYVENetwork.kyve.registry.MsgSubmitBundleProposal",
                value: {
                    creator: await this.client.getAddress(),
                    id: this.poolId,
                    bundleId: transaction.id,
                    byteSize: +transaction.data_size,
                    bundleSize: uploadBundle.toHeight - uploadBundle.fromHeight,
                },
            });
            utils_2.logger.debug(`Arweave Transaction ${transaction.id} ...`);
            utils_2.logger.debug(`Transaction = ${tx.transactionHash}`);
        }
        catch (error) {
            utils_2.logger.error("❌ Received an error while trying to upload bundle to Arweave. Skipping upload ...");
            utils_2.logger.debug(error);
        }
    }
    async claimUploaderRole() {
        try {
            utils_2.logger.info("🔍 Claiming uploader role ...");
            const tx = await this.client.sendMessage({
                typeUrl: "/KYVENetwork.kyve.registry.MsgClaimUploaderRole",
                value: {
                    creator: await this.client.getAddress(),
                    id: this.poolId,
                },
            });
            utils_2.logger.debug(`Transaction = ${tx.transactionHash}`);
        }
        catch (error) {
            utils_2.logger.error("❌ Received an error while to claim uploader role. Skipping ...");
            utils_2.logger.debug(error);
        }
    }
    async nextBundleProposal(createdAt) {
        return new Promise(async (resolve) => {
            utils_2.logger.debug("Waiting for new proposal ...");
            while (true) {
                await this.getPool(false);
                if (+this.pool.bundleProposal.createdAt > +createdAt) {
                    break;
                }
                else {
                    await (0, helpers_1.sleep)(2 * 1000); // sleep 2 secs
                }
            }
            resolve();
        });
    }
    async vote(vote) {
        utils_2.logger.info(`🖋  Voting ${vote.valid ? "valid" : "invalid"} on bundle ${vote.transaction} ...`);
        try {
            const tx = await this.client.sendMessage({
                typeUrl: "/KYVENetwork.kyve.registry.MsgVoteProposal",
                value: {
                    creator: await this.client.getAddress(),
                    id: this.poolId,
                    bundleId: vote.transaction,
                    support: vote.valid,
                },
            });
            utils_2.logger.debug(`Transaction = ${tx.transactionHash}`);
        }
        catch (error) {
            utils_2.logger.error("❌ Received an error while trying to vote. Skipping ...");
            utils_2.logger.debug(error);
        }
    }
    async logNodeInfo() {
        const formatInfoLogs = (input) => {
            const length = Math.max(13, this.runtime.length);
            return input.padEnd(length, " ");
        };
        let height;
        try {
            height = parseInt(await this.db.get("head"));
        }
        catch {
            height = 0;
        }
        utils_2.logger.info(`🚀 Starting node ...\n\n\t${formatInfoLogs("Node name")} = ${this.name}\n\t${formatInfoLogs("Address")} = ${await this.client.getAddress()}\n\t${formatInfoLogs("Pool Id")} = ${this.poolId}\n\t${formatInfoLogs("Cache height")} = ${height}\n\t${formatInfoLogs("@kyve/core")} = v${package_json_1.version}\n\t${formatInfoLogs(this.runtime)} = v${this.version}\n`);
    }
    setupMetrics() {
        if (this.runMetrics) {
            utils_2.logger.info("🔬 Starting metric server on: http://localhost:8080/metrics");
            // HTTP server which exposes the metrics on http://localhost:8080/metrics
            http_1.default
                .createServer(async (req, res) => {
                // Retrieve route from request object
                const route = url_1.default.parse(req.url).pathname;
                if (route === "/metrics") {
                    // Return all metrics the Prometheus exposition format
                    res.setHeader("Content-Type", prom_client_1.register.contentType);
                    const defaultMetrics = await prom_client_1.register.metrics();
                    const other = await KYVE.metrics.register.metrics();
                    res.end(defaultMetrics + "\n" + other);
                }
            })
                .listen(8080);
        }
    }
    async getPool(logs = true) {
        if (logs) {
            utils_2.logger.debug("Attempting to fetch pool state.");
        }
        return new Promise(async (resolve) => {
            while (true) {
                try {
                    const { data: { Pool }, } = await axios_1.default.get(`${this.client.endpoints.rest}/kyve/registry/pool/${this.poolId}`);
                    this.pool = { ...Pool };
                    try {
                        this.pool.config = JSON.parse(this.pool.config);
                    }
                    catch (error) {
                        utils_2.logger.error("❌ Received an error while trying to parse the config:");
                        utils_2.logger.debug(error);
                        process.exit(1);
                    }
                    if (this.pool.runtime === this.runtime) {
                        if (logs) {
                            utils_2.logger.info(`💻 Running node on runtime ${this.runtime}.`);
                        }
                    }
                    else {
                        utils_2.logger.error("❌ Specified pool does not match the integration runtime.");
                        process.exit(1);
                    }
                    try {
                        if ((0, semver_1.satisfies)(this.version, this.pool.versions || this.version)) {
                            if (logs) {
                                utils_2.logger.info("⏱  Pool version requirements met.");
                            }
                        }
                        else {
                            utils_2.logger.error(`❌ Running an invalid version for the specified pool. Version requirements are ${this.pool.versions}.`);
                            process.exit(1);
                        }
                    }
                    catch (error) {
                        utils_2.logger.error("❌ Received an error while trying parse versions");
                        utils_2.logger.debug(error);
                        process.exit(1);
                    }
                    break;
                }
                catch (error) {
                    utils_2.logger.error("❌ Received an error while trying to fetch the pool state");
                    await (0, helpers_1.sleep)(10 * 1000);
                }
            }
            if (logs) {
                utils_2.logger.info("✅ Fetched pool state");
            }
            resolve();
        });
    }
    async verifyNode(logs = true) {
        if (logs) {
            utils_2.logger.debug("Attempting to verify node.");
        }
        return new Promise(async (resolve) => {
            while (true) {
                try {
                    const isStaker = this.pool.stakers.includes(await this.client.getAddress());
                    if (isStaker) {
                        if (logs) {
                            utils_2.logger.info("🔍  Node is running as a validator.");
                        }
                        break;
                    }
                    else {
                        utils_2.logger.info(`⚠️  Node is no active validator!`);
                        utils_2.logger.info(`⚠️  Stake KYVE here to join as a validator: https://app.kyve.network/pools/${this.poolId}/validators - Idling ...`);
                        await (0, helpers_1.sleep)(60 * 1000);
                        await this.getPool(false);
                    }
                }
                catch (error) {
                    utils_2.logger.error("❌ Received an error while trying to fetch validator info");
                    await (0, helpers_1.sleep)(10 * 1000);
                }
            }
            if (logs) {
                utils_2.logger.info("✅ Validated node");
            }
            resolve();
        });
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
    // TODO: move to separate file
    generateRandomName(mnemonic) {
        const r = new prando_1.default(mnemonic + this.poolId);
        return (0, unique_names_generator_1.uniqueNamesGenerator)({
            dictionaries: [unique_names_generator_1.adjectives, unique_names_generator_1.colors, unique_names_generator_1.animals],
            separator: "-",
            length: 3,
            style: "lowerCase",
            seed: r.nextInt(0, unique_names_generator_1.adjectives.length * unique_names_generator_1.colors.length * unique_names_generator_1.animals.length),
        }).replace(" ", "-");
    }
}
KYVE.metrics = prom_client_1.default;
exports.default = KYVE;
