import { type Hex, type MaybePromise } from "../base.ts";
import type { IRequestTransport } from "../transports/base.ts";
import type { AbstractWallet } from "../signing/mod.ts";
import type {
    OrderResponse,
} from "../types/exchange/responses.ts";
import { SymbolConversion } from "../utils/symbolConversion.ts";
import { CancelResponseSuccess,} from "../clients/exchange.ts";
import { Order } from "../types/info/orders.ts";
import { InfoClient } from "../clients/info.ts";
import { ExchangeClient } from "../clients/exchange.ts";

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
    private transport: T;
    private wallet: W;
    private isTestnet: boolean;
    private defaultVaultAddress?: Hex;
    private defaultExpiresAfter?: number | (() => MaybePromise<number>);
    private signatureChainId?: Hex | (() => MaybePromise<Hex>);
    private nonceManager: () => MaybePromise<number>;
    private useSymbolConversion: boolean;
    private symbolConversion?: SymbolConversion<T>;
    private user : Hex;
    private hasSymbolConversion: boolean;
    private infoClient: InfoClient<T>;
    private exchangeClient: ExchangeClient<T, W>;

    
    constructor(args: CustomExchangeClientParameters<T, W>) {
        this.transport = args.transport;
        this.wallet = args.wallet;
        this.isTestnet = args.isTestnet ?? false;
        this.defaultVaultAddress = args.defaultVaultAddress;
        this.defaultExpiresAfter = args.defaultExpiresAfter;
        this.signatureChainId = args.signatureChainId ;
        this.nonceManager = args.nonceManager ?? new NonceManager().getNonce;
        this.useSymbolConversion = args.useSymbolConversion || false;
        this.symbolConversion = args.symbolConversion;
        this.user = args.user;
        // Pre-compute whether we have symbol conversion capability
        this.hasSymbolConversion = this.useSymbolConversion && !!this.symbolConversion;
        this.infoClient = new InfoClient(
            { transport: this.transport,
                useSymbolConversion: this.useSymbolConversion,
                symbolConversion: this.symbolConversion });
        this.exchangeClient = new ExchangeClient(
            { transport: this.transport,
                wallet: this.wallet,
                isTestnet: this.isTestnet,
                defaultVaultAddress: this.defaultVaultAddress,
                defaultExpiresAfter: this.defaultExpiresAfter,
                signatureChainId: this.signatureChainId,
                nonceManager: this.nonceManager,
                useSymbolConversion: this.useSymbolConversion,
                symbolConversion: this.symbolConversion });
    }


      async getAllAssets(): Promise<{ perp: string[]; spot: string[] }> {
          return await this.symbolConversion!.getAllAssets();
        }


    async cancelAllOrders(symbol?: string): Promise<CancelResponseSuccess> {
        try {
          const address = this.user;
          const openOrders: Order[] = await this.infoClient.openOrders({ user: address });
    
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
          const response = await this.exchangeClient.cancel(cancelParams);
          return response;
        } catch (error) {
          throw error;
        }
      }


      async cancelAllSpotOrders(): Promise<CancelResponseSuccess> {
        try {
          const address = this.user;
          const openOrders: Order[] = await this.infoClient.openOrders({ user: address });
    
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
    
          const response = await this.exchangeClient.cancel(cancelParams);
          return response;
        } catch (error) {
          throw error;
        }
      }
    
      async cancelAllPerpOrders(): Promise<CancelResponseSuccess> {
        try {
          const address = this.user;
          const openOrders: Order[] = await this.infoClient.openOrders({ user: address });
    
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
    
          const response = await this.exchangeClient.cancel(cancelParams);
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
            const allMids = await this.infoClient.allMids();
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
            const positions = await this.infoClient.clearinghouseState({user: address});
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
                    p: slippagePrice.toString(), // Convert number to string
                    s: closeSize.toString(), // Convert number to string
                    r: true,
                    t: { limit: { tif: 'Ioc' } },
                }],
                grouping: "na" // No grouping
            };
            console.log("orderRequest", orderRequest)

            if (cloid) {
                orderRequest.orders[0].cloid = cloid;
            }

            return this.exchangeClient.order(orderRequest);
            }

            throw new Error(`No position found for ${symbol}`);
        }

        async closeAllPositions(slippage: number = this.DEFAULT_SLIPPAGE): Promise<OrderResponse[]> {
            try {
            const address = this.user;
            const positions = await this.infoClient.clearinghouseState({user: address});
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










    async [Symbol.asyncDispose](): Promise<void> {
        await this.transport[Symbol.asyncDispose]?.();
    }
}
