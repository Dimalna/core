import { JWKInterface } from "arweave/node/lib/wallet";
import { UploadFunction, ValidateFunction } from "./faces";
import { CLI } from "./utils";
declare class KYVE {
    private pool;
    private node;
    private runtime;
    private version;
    private stake;
    private wallet;
    private keyfile?;
    private name;
    private gasMultiplier;
    private buffer;
    private metadata;
    private settings;
    private config;
    private client;
    constructor(poolAddress: string, runtime: string, version: string, stakeAmount: string, privateKey: string, keyfile?: JWKInterface, name?: string, endpoint?: string, gasMultiplier?: string);
    static generate(cli?: CLI): Promise<KYVE>;
    run<ConfigType>(uploadFunction: UploadFunction<ConfigType>, validateFunction: ValidateFunction<ConfigType>): Promise<void>;
    private uploader;
    private listener;
    private validator;
    private vote;
    private logNodeInfo;
    private setupListeners;
    private fetchPoolState;
    private checkVersionRequirements;
    private checkRuntimeRequirements;
    private setupNodeContract;
    private selfDelegate;
    private selfUndelegate;
}
export default KYVE;
