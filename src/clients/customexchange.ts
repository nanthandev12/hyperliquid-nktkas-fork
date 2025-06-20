import { type Hex, type MaybePromise } from "../base.ts";
import type { IRequestTransport } from "../transports/base.ts";
import type {
    BaseExchangeRequest,
    CancelRequest,
    OrderRequest
   
} from "../types/exchange/requests.ts";
import type {
    CancelResponse,
    ErrorResponse,
    OrderResponse,
    SuccessResponse,
} from "../types/exchange/responses.ts";
import {
    type AbstractWallet,
    actionSorter,
    isAbstractEthersSigner,
    isAbstractEthersV5Signer,
    isAbstractViemWalletClient,
    isAbstractWindowEthereum,
    signL1Action,
} from "../signing/mod.ts";
import { SymbolConversion } from "../utils/symbolConversion.ts";
import { AllMidsRequest, OpenOrdersRequest } from "../types/info/requests.ts";
import { OpenOrdersParameters, 
    ClearinghouseStateParameters, 
    AllMidsParameters } from "../clients/info.ts";
import { CancelResponseSuccess,
    OrderResponseSuccess,
    CancelParameters,
    OrderParameters, 
    ApiRequestError} from "../clients/exchange.ts";
import { Order } from "../types/info/orders.ts";
import { AllMids } from "../types/info/assets.ts";
import { PerpsClearinghouseState } from "../types/info/accounts.ts";
import { ClearinghouseStateRequest } from "../types/info/requests.ts";

/** Parameters for the {@linkcode ExchangeClient} constructor. */
export interface CustomExchangeClientParameters<
    T extends IRequestTransport = IRequestTransport,
    W extends AbstractWallet = AbstractWallet,
> {
    /** The transport used to connect to the Hyperliquid API. */
    transport: T;
    /** The `viem`, `ethers.js`, or `window.ethereum` wallet used for signing transactions. */
    wallet: W;
    /**
     * Specifies whether the client uses testnet.
     *
     * Defaults to `false`.
     */
    isTestnet?: boolean;
    /** Sets a default vaultAddress to be used if no vaultAddress is explicitly passed to a method. */
    defaultVaultAddress?: Hex;
    /** Sets a default expiresAfter to be used if no expiresAfter is explicitly passed to a method. */
    defaultExpiresAfter?: number | (() => MaybePromise<number>);
    /**
     * The network that will be used to sign transactions.
     * Must match the network of the {@link wallet}.
     *
     * Defaults to trying to get the current wallet network. Otherwise `0xa4b1` for `isTestnet = false` or `0x66eee` for `isTestnet = true` will be used.
     */
    signatureChainId?: Hex | (() => MaybePromise<Hex>);
    /**
     * Function to get the next nonce for signing transactions.
     *
     * Defaults to a function that returns the current timestamp or, if duplicated, increments the last nonce.
     */
    nonceManager?: () => MaybePromise<number>;
    /**
     * Whether to use symbol conversion for coin names.
     * 
     * When true, coins like "BTC" will be converted to their underlying API format (like "BTC-PERP").
     * 
     * Defaults to `false`.
     */
    useSymbolConversion?: boolean;
    /**
     * The symbol conversion instance to use if useSymbolConversion is true.
     * 
     * Required if useSymbolConversion is true.
     */
    symbolConversion?: any;
    /**
     * The user address to use for signing transactions.
     */
    user : Hex;
}




/** Nonce manager for generating unique nonces for signing transactions. */
class NonceManager {
    /** The last nonce used for signing transactions. */
    private lastNonce = 0;

    /**
     * Gets the next nonce for signing transactions.
     * @returns The next nonce.
     */
    getNonce(): number {
        let nonce = Date.now();
        if (nonce <= this.lastNonce) {
            nonce = ++this.lastNonce;
        } else {
            this.lastNonce = nonce;
        }
        return nonce;
    }
}

/**
 * Exchange client for interacting with the Hyperliquid API.
 * @typeParam T The transport used to connect to the Hyperliquid API.
 * @typeParam W The wallet used for signing transactions.
 */
export class CustomExchangeClient<
    T extends IRequestTransport = IRequestTransport,
    W extends AbstractWallet = AbstractWallet,
> implements CustomExchangeClientParameters<T, W>, AsyncDisposable {
    transport: T;
    wallet: W;
    isTestnet: boolean;
    defaultVaultAddress?: Hex;
    defaultExpiresAfter?: number | (() => MaybePromise<number>);
    signatureChainId: Hex | (() => MaybePromise<Hex>);
    nonceManager: () => MaybePromise<number>;
    useSymbolConversion: boolean;
    symbolConversion?: SymbolConversion<T>;
    user : Hex;
    private hasSymbolConversion: boolean;


    

    /**
     * Initialises a new instance.
     * @param args - The parameters for the client.
     *
     * @example Private key
     * ```ts
     * import * as hl from "@nktkas/hyperliquid";
     *
     * const privateKey = "0x...";
     *
     * const transport = new hl.HttpTransport(); // or `WebSocketTransport`
     * const exchClient = new hl.ExchangeClient({ wallet: privateKey, transport });
     * ```
     *
     * @example Private key via [viem](https://viem.sh/docs/clients/wallet#local-accounts-private-key-mnemonic-etc)
     * ```ts
     * import * as hl from "@nktkas/hyperliquid";
     * import { privateKeyToAccount } from "viem/accounts";
     *
     * const wallet = privateKeyToAccount("0x...");
     *
     * const transport = new hl.HttpTransport(); // or `WebSocketTransport`
     * const exchClient = new hl.CustomExchangeClient({ wallet, transport });
     * ```
     *
     * @example Private key via [ethers.js](https://docs.ethers.org/v6/api/wallet/#Wallet) or [ethers.js v5](https://docs.ethers.org/v5/api/signer/#Wallet)
     * ```ts
     * import * as hl from "@nktkas/hyperliquid";
     * import { ethers } from "ethers";
     *
     * const wallet = new ethers.Wallet("0x...");
     *
     * const transport = new hl.HttpTransport(); // or `WebSocketTransport`
     * const exchClient = new hl.ExchangeClient({ wallet, transport });
     * ```
     *
     * @example External wallet (e.g. MetaMask) via [viem](https://viem.sh/docs/clients/wallet#optional-hoist-the-account)
     * ```ts
     * import * as hl from "@nktkas/hyperliquid";
     * import { createWalletClient, custom } from "viem";
     *
     * const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
     * const wallet = createWalletClient({ account, transport: custom(window.ethereum) });
     *
     * const transport = new hl.HttpTransport(); // or `WebSocketTransport`
     * const exchClient = new hl.ExchangeClient({ wallet, transport });
     * ```
     *
     * @example External wallet (e.g. MetaMask) via `window.ethereum` directly
     * ```ts
     * import * as hl from "@nktkas/hyperliquid";
     *
     * const transport = new hl.HttpTransport(); // or `WebSocketTransport`
     * const exchClient = new hl.ExchangeClient({ wallet: window.ethereum, transport });
     * ```
     */
    constructor(args: CustomExchangeClientParameters<T, W>) {
        this.transport = args.transport;
        this.wallet = args.wallet;
        this.isTestnet = args.isTestnet ?? false;
        this.defaultVaultAddress = args.defaultVaultAddress;
        this.defaultExpiresAfter = args.defaultExpiresAfter;
        this.signatureChainId = args.signatureChainId ?? this._guessSignatureChainId;
        this.nonceManager = args.nonceManager ?? new NonceManager().getNonce;
        this.useSymbolConversion = args.useSymbolConversion || false;
        this.symbolConversion = args.symbolConversion;
        this.user = args.user;
        // Pre-compute whether we have symbol conversion capability
        this.hasSymbolConversion = this.useSymbolConversion && !!this.symbolConversion;
    }

    private async getAssetIndex(symbol: string): Promise<number> {
        if (!this.hasSymbolConversion) {
            throw new Error("Symbol conversion is not enabled");
        }
        
        const index = await this.symbolConversion!.getAssetIndex(symbol);
        if (index === undefined) {
            throw new Error(`Unknown asset: ${symbol}`);
        }
        return index;
    }


    async openOrders(args: OpenOrdersParameters, signal?: AbortSignal): Promise<Order[]> {
        const request: OpenOrdersRequest = {
            type: "openOrders",
            ...args,
        };
        const response = await this.transport.request<Order[]>("info", request, signal)
        return this.hasSymbolConversion
            ? await this.symbolConversion!.convertResponse(response)
            : response;
    }

    allMids(args?: AllMidsParameters, signal?: AbortSignal): Promise<AllMids>;
    allMids(signal?: AbortSignal): Promise<AllMids>;
    async allMids(args_or_signal?: AllMidsParameters | AbortSignal, maybeSignal?: AbortSignal): Promise<AllMids> {
        const args = args_or_signal instanceof AbortSignal ? {} : args_or_signal;
        const signal = args_or_signal instanceof AbortSignal ? args_or_signal : maybeSignal;

        const request: AllMidsRequest = {
            type: "allMids",
            ...args,
        };
        
        const response = await this.transport.request<AllMids>("info", request, signal)
            
        if (this.hasSymbolConversion) {
            const convertedResponse: any = {};
            for (const [key, value] of Object.entries(response)) {
                const convertedKey = await this.symbolConversion!.convertSymbol(key);
                const convertedValue = parseFloat(value as string);
                convertedResponse[convertedKey] = convertedValue;
            }
            return convertedResponse as AllMids;
        } else {
            return response;
        }
    }

      async clearinghouseState(args: ClearinghouseStateParameters, signal?: AbortSignal): Promise<PerpsClearinghouseState> {
            const request: ClearinghouseStateRequest = {
                type: "clearinghouseState",
                ...args,
            };
            const response = await this.transport.request<PerpsClearinghouseState>("info", request, signal)
            return this.hasSymbolConversion
                ? await this.symbolConversion!.convertResponse(response, ['name', 'coin', 'symbol'], 'PERP')
                : response;
        }


        async getAllAssets(): Promise<{ perp: string[]; spot: string[] }> {
            return await this.symbolConversion!.getAllAssets();
          }






    /**
     * Cancel order(s).
     * @param args - The parameters for the request.
     * @param signal - An optional abort signal.
     * @returns Successful variant of {@link CancelResponse} without error statuses.
     * @throws {ApiRequestError} When the API returns an error response.
     *
     * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#cancel-order-s
     * @example
     * ```ts
     * import * as hl from "@nktkas/hyperliquid";
     *
     * const privateKey = "0x..."; // or `viem`, `ethers`
     * const transport = new hl.HttpTransport(); // or `WebSocketTransport`
     * const exchClient = new hl.ExchangeClient({ wallet: privateKey, transport });
     *
     * const data = await exchClient.cancel({
     *   cancels: [{
     *     a: 0, // Asset index
     *     o: 123, // Order ID
     *   }],
     * });
     * ```
     */
    async cancel(args: CancelParameters, signal?: AbortSignal): Promise<CancelResponseSuccess> {
        // Destructure the parameters
        const {
            vaultAddress = this.defaultVaultAddress,
            expiresAfter = await this._getDefaultExpiresAfter(),
            ...actionArgs
        } = args;

        // Process symbol conversion for cancels if needed
        let convertedActionArgs = { ...actionArgs };
        
        // Convert asset IDs from symbols to indices if symbol conversion is enabled
        if (this.hasSymbolConversion && actionArgs.cancels) {
            const convertedCancels = await Promise.all(actionArgs.cancels.map(async (cancel) => {
                if (typeof cancel.a === 'string') {
                    // Convert the symbol to asset index
                    const assetIndex = await this.getAssetIndex(cancel.a);
                    return { ...cancel, a: assetIndex };
                }
                return cancel;
            }));
            
            convertedActionArgs.cancels = convertedCancels;
        }

        // Construct an action
        const nonce = await this.nonceManager();
        const action: CancelRequest["action"] = {
            type: "cancel",
            ...convertedActionArgs,
        };

        // Sign the action
        const signature = await signL1Action({
            wallet: this.wallet,
            action: actionSorter[action.type](action),
            nonce,
            isTestnet: this.isTestnet,
            vaultAddress,
            expiresAfter,
        });

        // Send a request
        return await this._request(
            { action, signature, nonce, vaultAddress, expiresAfter } satisfies CancelRequest,
            signal,
        );
    }




    async cancelAllOrders(symbol?: string): Promise<CancelResponseSuccess> {
        try {
          const address = this.user;
          const openOrders: Order[] = await this.openOrders({ user: address });
    
          let ordersToCancel: Order[];
    
          for (let order of openOrders) {
            order.coin = await this.symbolConversion!.convertSymbol(order.coin);
          }
    
          if (symbol) {
            ordersToCancel = openOrders.filter(order => order.coin === symbol);
          } else {
            ordersToCancel = openOrders;
          }
    
          if (ordersToCancel.length === 0) {
            throw new Error('No orders to cancel');
          }
    
          // Create the cancellation parameters
          // The cancel method's symbol conversion feature will handle string asset names
          const cancelParams: any = {
            cancels: ordersToCancel.map(order => ({
              a: order.coin, // Will be converted from symbol to asset index
              o: order.oid
            }))
          };
          
          // Pass it to the cancel method
          const response = await this.cancel(cancelParams);
          return response;
        } catch (error) {
          throw error;
        }
      }


      async cancelAllSpotOrders(): Promise<CancelResponseSuccess> {
        try {
          const address = this.user;
          const openOrders: Order[] = await this.openOrders({ user: address });
    
          // Get all spot assets to identify spot orders
          const { spot } = await this.getAllAssets();
          const spotSymbols = new Set(spot);
    
          // Process all orders to get proper symbol names
          for (let order of openOrders) {
            order.coin = await this.symbolConversion!.convertSymbol(order.coin);
          }
    
          // Filter only spot orders by matching against known spot symbols
          const spotOrders = openOrders.filter(order => {
            const isSpot =
              spotSymbols.has(order.coin) ||
              (!order.coin.endsWith('-PERP') && order.coin.includes('-'));
            return isSpot;
          });
    
          if (spotOrders.length === 0) {
            throw new Error('No spot orders to cancel');
          }
    
          const cancelParams: any = {
            cancels: spotOrders.map(order => ({
              a: order.coin, // Will be converted from symbol to asset index
              o: order.oid
            }))
          };
    
          const response = await this.cancel(cancelParams);
          return response;
        } catch (error) {
          throw error;
        }
      }
    
      async cancelAllPerpOrders(): Promise<CancelResponseSuccess> {
        try {
          const address = this.user;
          const openOrders: Order[] = await this.openOrders({ user: address });
    
          // Get all perp assets to identify perp orders
          const { perp } = await this.getAllAssets();
          console.log("perp",perp)
          const perpSymbols = new Set(perp);
          console.log("perpSymbols",perpSymbols)
    
          // Process all orders to get proper symbol names
          for (let order of openOrders) {
            order.coin = await this.symbolConversion!.convertSymbol(order.coin);
          }
    
          // Filter only perpetual orders by matching against known perp symbols
          const perpOrders = openOrders.filter(order => {
            const isPerp = perpSymbols.has(order.coin) || order.coin.endsWith('-PERP');
            return isPerp;
          });
          console.log("perpOrders",perpOrders)
    
          if (perpOrders.length === 0) {
            throw new Error('No perpetual orders to cancel');
          }
    
          const cancelParams: any = {
            cancels: perpOrders.map(order => ({
              a: order.coin, // Will be converted from symbol to asset index
              o: order.oid
            }))
          };
    
          const response = await this.cancel(cancelParams);
          return response;
        } catch (error) {
          throw error;
        }
      }
    
   

        private DEFAULT_SLIPPAGE = 0.05;

        private async getSlippagePrice(
            symbol: string,
            isBuy: boolean,
            slippage: number,
            px?: number
        ): Promise<number> {
            if (!px) {
            const allMids = await this.allMids();
            px = Number(allMids[symbol]);
            }

            const isSpot = symbol.includes('-USDC');

            //If not isSpot count how many decimals price has to use the same amount for rounding
            const decimals = px.toString().split('.')[1]?.length || 0;

            console.log(decimals);

            px *= isBuy ? 1 + slippage : 1 - slippage;
            return Number(px.toFixed(isSpot ? 8 : Math.max(0, decimals - 1)));
        }



        async marketClose(
            symbol: string,
            size?: number,
            px?: number,
            slippage: number = this.DEFAULT_SLIPPAGE,
            cloid?: string
        ): Promise<OrderResponse> {
            const address = this.user;
            const positions = await this.clearinghouseState({user: address});
            for (const position of positions.assetPositions) {
            const item = position.position;
            if (symbol !== item.coin) {
                continue;
            }
            const szi = parseFloat(item.szi);
            const closeSize = size || Math.abs(szi);
            const isBuy = szi < 0;

            // Get aggressive Market Price
            const slippagePrice = await this.getSlippagePrice(symbol, isBuy, slippage, px);
            console.log("slippagePrice",slippagePrice)

            // Market Order is an aggressive Limit Order IoC
            const orderRequest: any = {
                orders: [{
                    a: symbol,
                    b: isBuy,
                    s: closeSize.toString(), // Convert number to string
                    p: slippagePrice.toString(), // Convert number to string
                    t: { limit: { tif: 'Ioc' } },
                    r: true,
                }],
                grouping: "na" // No grouping
            };
            console.log("orderRequest", orderRequest)

            if (cloid) {
                orderRequest.orders[0].cloid = cloid;
            }

            return this.order(orderRequest);
            }

            throw new Error(`No position found for ${symbol}`);
        }

        async closeAllPositions(slippage: number = this.DEFAULT_SLIPPAGE): Promise<OrderResponse[]> {
            try {
            const address = this.user;
            const positions = await this.clearinghouseState({user: address});
            const closeOrders: Promise<OrderResponse>[] = [];

            console.log(positions.assetPositions);

            for (const position of positions.assetPositions) {
                const item = position.position;
                if (parseFloat(item.szi) !== 0) {
                const symbol = item.coin;
                closeOrders.push(this.marketClose(symbol, undefined, undefined, slippage));
                }
            }

            return await Promise.all(closeOrders);
            } catch (error) {
            throw error;
            }
        }







    /**
     * Place an order(s).
     * @param args - The parameters for the request.
     * @param signal - An optional abort signal.
     * @returns Successful variant of {@link OrderResponse} without error statuses.
     * @throws {ApiRequestError} When the API returns an error response.
     *
     * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#place-an-order
     * @example
     * ```ts
     * import * as hl from "@nktkas/hyperliquid";
     *
     * const privateKey = "0x..."; // or `viem`, `ethers`
     * const transport = new hl.HttpTransport(); // or `WebSocketTransport`
     * const exchClient = new hl.ExchangeClient({ wallet: privateKey, transport });
     *
     * const data = await exchClient.order({
     *   orders: [{
     *     a: 0, // Asset index
     *     b: true, // Buy order
     *     p: "30000", // Price
     *     s: "0.1", // Size
     *     r: false, // Not reduce-only
     *     t: {
     *       limit: {
     *         tif: "Gtc", // Good-til-cancelled
     *       },
     *     },
     *     c: "0x...", // Client Order ID (optional)
     *   }],
     *   grouping: "na", // No grouping
     * });
     * ```
     */
    async order(args: OrderParameters, signal?: AbortSignal): Promise<OrderResponseSuccess> {
        // Destructure the parameters
        const {
            vaultAddress = this.defaultVaultAddress,
            expiresAfter = await this._getDefaultExpiresAfter(),
            ...actionArgs
        } = args;

        // Convert asset IDs from symbols to indices if symbol conversion is enabled
        let convertedActionArgs = { ...actionArgs };
        
        // Convert asset IDs from symbols to indices if symbol conversion is enabled
        if (this.hasSymbolConversion && actionArgs.orders) {
            const convertedOrders = await Promise.all(actionArgs.orders.map(async (order) => {
                if (typeof order.a === 'string') {
                    // Convert the symbol to asset index
                    const assetIndex = await this.getAssetIndex(order.a);
                    return { ...order, a: assetIndex };
                }
                return order;
            }));
            
            convertedActionArgs.orders = convertedOrders;
        }

        // Construct an action
        const nonce = await this.nonceManager();
        const action: OrderRequest["action"] = {
            type: "order",
            ...convertedActionArgs,
        };

        // Sign the action
        const signature = await signL1Action({
            wallet: this.wallet,
            action: actionSorter[action.type](action),
            nonce,
            isTestnet: this.isTestnet,
            vaultAddress,
            expiresAfter,
        });

        // Send a request
        return await this._request(
            { action, signature, nonce, vaultAddress, expiresAfter } satisfies OrderRequest,
            signal,
        );
    }



    /** Send an API request and validate the response. */
    protected async _request<
        T extends
            | SuccessResponse
            | CancelResponseSuccess
            | OrderResponseSuccess,
    >(payload: BaseExchangeRequest, signal?: AbortSignal): Promise<T> {
        const response = await this.transport.request<
            | SuccessResponse
            | ErrorResponse
            | CancelResponse
            | OrderResponse
        >("exchange", payload, signal);
        this._validateResponse(response);
        return response as T;
    }

    /** Guesses the chain ID based on the wallet type or the isTestnet flag. */
    protected async _guessSignatureChainId(): Promise<Hex> {
        // Trying to get chain ID of the wallet
        if (isAbstractViemWalletClient(this.wallet)) {
            if ("getChainId" in this.wallet && typeof this.wallet.getChainId === "function") {
                const chainId = await this.wallet.getChainId() as number;
                return `0x${chainId.toString(16)}`;
            }
        } else if (isAbstractEthersSigner(this.wallet) || isAbstractEthersV5Signer(this.wallet)) {
            if (
                "provider" in this.wallet &&
                typeof this.wallet.provider === "object" && this.wallet.provider !== null &&
                "getNetwork" in this.wallet.provider &&
                typeof this.wallet.provider.getNetwork === "function"
            ) {
                const network = await this.wallet.provider.getNetwork() as { chainId: number | bigint };
                return `0x${network.chainId.toString(16)}`;
            }
        } else if (isAbstractWindowEthereum(this.wallet)) {
            const [chainId] = await this.wallet.request({ method: "eth_chainId", params: [] }) as Hex[];
            return chainId;
        }
        // Attempt to guess chain ID based on isTestnet
        return this.isTestnet ? "0x66eee" : "0xa4b1";
    }

    /** Get the default expiration time for an action. */
    protected async _getDefaultExpiresAfter(): Promise<number | undefined> {
        return typeof this.defaultExpiresAfter === "number"
            ? this.defaultExpiresAfter
            : await this.defaultExpiresAfter?.();
    }

    /** Get the signature chain ID for the wallet. */
    protected async _getSignatureChainId(): Promise<Hex> {
        return typeof this.signatureChainId === "string" ? this.signatureChainId : await this.signatureChainId();
    }

    /** Get the Hyperliquid chain based on the isTestnet flag. */
    protected _getHyperliquidChain(): "Mainnet" | "Testnet" {
        return this.isTestnet ? "Testnet" : "Mainnet";
    }

    /** Validate a response from the API. */
    protected _validateResponse(
        response:
            | SuccessResponse
            | ErrorResponse
            | CancelResponse
            | OrderResponse,
    ): asserts response is
        | SuccessResponse
        | CancelResponseSuccess
        | OrderResponseSuccess {
        if (response.status === "err") {
            throw new ApiRequestError(response as ErrorResponse);
        } else if (response.response.type === "order" || response.response.type === "cancel") {
            if (response.response.data.statuses.some((status) => typeof status === "object" && "error" in status)) {
                throw new ApiRequestError(response as OrderResponse | CancelResponse);
            }
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.transport[Symbol.asyncDispose]?.();
    }
}
