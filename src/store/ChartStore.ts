/* eslint-disable prefer-rest-params */
/* eslint-disable @typescript-eslint/no-this-alias */
import { action, computed, observable, reaction, makeObservable } from 'mobx';
import moment from 'moment';
import { TickHistoryFormatter } from 'src/feed/TickHistoryFormatter';
import MainStore from '.';
import { ActiveSymbols, BinaryAPI, TradingTimes } from '../binaryapi';
import { TProcessedSymbolItem, TSubCategoryDataItem } from '../binaryapi/ActiveSymbols';

import Context from '../components/ui/Context';
import { STATE } from '../Constant';
import { Feed } from '../feed';
import {
    IPendingPromise,
    TChanges,
    TChartProps,
    TGranularity,
    TNetworkConfig,
    TPaginationCallbackParams,
    TQuote,
    TRatio,
} from '../types';
import { cloneCategories } from '../utils';
import PendingPromise from '../utils/PendingPromise';
import BarrierStore from './BarrierStore';
import ChartState from './ChartState';

type TDefaults = {
    granularity: TGranularity;
    chartType: React.ReactNode;
};

class ChartStore {
    static chartCount = 0;
    static tradingTimes: TradingTimes | null;
    static activeSymbols: ActiveSymbols;

    onStreamingData(data: { type: 'tick' | 'candle'; instrument_id: string; quote?: number; timestamp: string; ohlc?: { open: number; high: number; low: number; close: number } }) {
        if (!this.feed || !data) return;
        
        const epoch = Math.floor(new Date(data.timestamp).getTime() / 1000);
        
        const adaptedData = data.type === 'tick' 
            ? {
                msg_type: 'tick' as const,
                tick: {
                    epoch,
                    quote: data.quote || 0,
                    symbol: data.instrument_id,
                    pip_size: 2,
                },
                echo_req: {},
            }
            : {
                msg_type: 'ohlc' as const,
                ohlc: {
                    open_time: epoch,
                    open: String(data.ohlc?.open || 0),
                    high: String(data.ohlc?.high || 0),
                    low: String(data.ohlc?.low || 0),
                    close: String(data.ohlc?.close || 0),
                    epoch,
                    symbol: data.instrument_id,
                    id: `${data.instrument_id}_${epoch}`,
                    granularity: 60,
                },
                echo_req: {},
            };
        
        const formattedData = TickHistoryFormatter.formatTick(adaptedData);
        if (!formattedData) return;
        
        this.feed.processQuotes([formattedData]);
        this.feed.addQuote(formattedData);
        
        if (formattedData.ohlc) {
            this.mainStore.chartAdapter.flutterChart?.feed.onNewCandle(formattedData);
        } else if (this.granularity! < 60000) {
            this.mainStore.chartAdapter.flutterChart?.feed.onNewTick(formattedData);
        }
    }

    chartContainerHeight?: number;
    chartHeight?: number;
    chartId?: string;
    containerWidth: number | null = null;
    context: Context | null = null;
    currentActiveSymbol?: TProcessedSymbolItem | null;
    currentLanguage?: string;
    cursorInChart = false;
    startWithDataFitMode = false;
    feed?: Feed | null;
    isBarrierDragging = false;
    isChartAvailable = true;
    isLive = false;
    isMobile?: boolean = false;
    isScaledOneOne = false;
    mainStore: MainStore;
    networkStatus?: TNetworkConfig;
    resizeObserver?: ResizeObserver;
    serverTime?: string;
    shouldRenderDialogs = false;
    leftMargin?: number;
    lastQuote?: TQuote;
    constructor(mainStore: MainStore) {
        makeObservable(this, {
            chartContainerHeight: observable,
            chartHeight: observable,
            containerWidth: observable,
            context: observable,
            currentActiveSymbol: observable,
            currentLanguage: observable,
            cursorInChart: observable,
            isBarrierDragging: observable,
            isChartAvailable: observable,
            isMobile: observable,
            isScaledOneOne: observable,
            networkStatus: observable,
            serverTime: observable,
            shouldRenderDialogs: observable,
            xAxisHeight: computed,
            yAxisWidth: computed,
            lastQuote: observable,
            _initChart: action.bound,
            categorizedSymbols: computed,
            changeSymbol: action.bound,
            destroy: action.bound,
            granularity: observable,
            newChart: action.bound,
            onServerTimeChange: action.bound,
            openFullscreen: action.bound,
            pip: computed,
            refreshChart: action.bound,
            resizeScreen: action.bound,
            setChartAvailability: action.bound,
            updateCurrentActiveSymbol: action.bound,
            updateScaledOneOne: action.bound,
        });

        this.mainStore = mainStore;
    }
    feedCall: { tradingTimes?: boolean; activeSymbols?: boolean } = {};
    RANGE_PADDING_PX = 125;
    contextPromise: IPendingPromise<Context, void> | null = PendingPromise<Context, void>();
    rootNode: HTMLElement | null = null;
    api: BinaryAPI | null = null;
    defaults: TDefaults = {
        granularity: 0,
        chartType: 'line',
    };
    granularity: TGranularity;
    enableRouting?: boolean | null = null;
    chartNode?: HTMLElement | null = null;
    chartControlsNode?: HTMLElement | null = null;
    state?: ChartState;
    onMessage = null;
    _barriers: BarrierStore[] = [];
    tradingTimes?: TradingTimes;
    activeSymbols?: ActiveSymbols;
    whitespace?: number;
    isDestroyed = false;
    get loader() {
        return this.mainStore.loader;
    }
    get routingStore() {
        return this.mainStore.routing;
    }
    get stateStore() {
        return this.mainStore.state;
    }
    get studiesStore() {
        return this.mainStore.studies;
    }
    get pip() {
        return this.currentActiveSymbol?.decimal_places;
    }
    get rootElement() {
        return this.chartId ? document.getElementById(this.chartId) : null;
    }

    get currentClose() {
        return this.currentCloseQuote()?.Close;
    }

    get xAxisHeight(): number {
        return window.flutterChart?.app.getXAxisHeight() || 24;
    }

    get yAxisWidth(): number {
        return window.flutterChart?.app.getYAxisWidth() || 60;
    }

    currentCloseQuote = (): TQuote | undefined => {
        const quotes = this.mainStore.chart.feed?.quotes;
        let currentQuote = quotes?.[quotes.length - 1];
        if (currentQuote && !currentQuote.Close) {
            const dataSegmentClose = quotes?.filter(item => item && item.Close);
            if (dataSegmentClose && dataSegmentClose.length) {
                currentQuote = dataSegmentClose[dataSegmentClose.length - 1];
            } else {
                const dataSetClose = quotes?.filter(item => item && item.Close);
                if (dataSetClose && dataSetClose.length) {
                    currentQuote = dataSetClose[dataSetClose.length - 1];
                }
            }
        }
        return currentQuote;
    };

    updateHeight(position?: string) {
        const historicalMobile = this.mainStore.chartSetting.historical && this.isMobile;
        const panelPosition = position || this.mainStore.chartSetting.position;
        // TODO use constant here for chartcontrol height
        let offsetHeight = 0;
        if (this.stateStore.enabledChartFooter) {
            offsetHeight = 32;
        } else if (panelPosition === 'bottom' && this.stateStore.chartControlsWidgets) {
            offsetHeight = 40;
        }
        this.chartHeight = this.chartNode?.offsetHeight;
        this.chartContainerHeight = (this.chartHeight || 0) - offsetHeight - (historicalMobile ? 45 : 0);
    }

    resizeScreen() {
        if (this.rootNode && this.rootNode.clientWidth >= 1280) {
            this.containerWidth = 1280;
        } else if (this.rootNode && this.rootNode.clientWidth >= 900) {
            this.containerWidth = 900;
        } else {
            this.containerWidth = 480;
        }
        this.updateHeight();
    }
    /**
     * Get the height ratio of each active indicator in the bottom of chart
     *
     * this method get the number of active indicator that locate in the bottom
     * chart and by considering the chart height return the height that each
     * indicator should have.
     * if the getIndicatorHeightRatio callback passed to the chart from parent
     * component, use that callback to calculate the height ratio. the callback
     * should return an object that contain {height, percent} properties. otherwise
     * the chart ignore it and calculate the ratio by itself
     *
     * @version 0.3.16
     * @param {number} num: count of active indicator in the bottom of chart
     * @returns {number} height: height of each active indicator in the bottom
     * @returns {number} percent: percent of height of an indicator compare to the chart heigh
     */
    indicatorHeightRatio = (num: number) => {
        let ratio = {} as TRatio;
        if (typeof this.stateStore.getIndicatorHeightRatio === 'function' && this.chartNode) {
            ratio = this.stateStore.getIndicatorHeightRatio(this.chartNode.offsetHeight, num);
        }
        if (this.chartNode && (!ratio || !ratio.height || !ratio.percent)) {
            const chartHeight = this.chartNode.offsetHeight;
            const isSmallScreen = chartHeight < 780;
            const denominator = num >= 5 ? num : num + 1;
            const reservedHeight = this.isMobile ? 160 : 320;
            const indicatorsHeight = Math.round(
                (chartHeight - (reservedHeight + (isSmallScreen ? 20 : 0))) / denominator
            );
            ratio = {
                height: indicatorsHeight,
                percent: indicatorsHeight / chartHeight,
            };
        }
        return ratio;
    };
    init = (rootNode: HTMLElement | null, props: React.PropsWithChildren<TChartProps>) => {
        this.loader.show();
        this.mainStore.state.setChartIsReady(false);
        this.loader.setState('chart-engine');
        this.chartId = props.id || 'base-chart';
        this._initChart(rootNode, props);

        this.mainStore.chartAdapter.newChart();


        const transformCandle = (candles: any[]) => candles.map(candle => ({
            close: candle.close,
            epoch: candle.timestamp ? Math.floor(new Date(candle.timestamp).getTime() / 1000) : candle.epoch,
            high: candle.high,
            low: candle.low,
            open: candle.open,
        }));

        const response = {
            msg_type: 'candles',
            candles: transformCandle([{
                    close: 911.73,
                    timestamp: '2025-02-08T10:03:00Z',
                    high: 912.75,
                    low: 910.75,
                    open: 912.49,
                },
                {
                    close: 911.65,
                    timestamp: '2025-02-08T10:04:00Z',
                    high: 912.57,
                    low: 911.36,
                    open: 911.76,
                },
                {
                    close: 911.03,
                    timestamp: '2025-02-08T10:05:00Z',
                    high: 913.06,
                    low: 910.75,
                    open: 911.82,
                },
                {
                    close: 912.72,
                    timestamp: '2025-02-08T10:06:00Z',
                    high: 912.72,
                    low: 911.0,
                    open: 911.0,
                },
                {
                    close: 913.11,
                    timestamp: '2025-02-08T10:07:00Z',
                    high: 913.36,
                    low: 912.34,
                    open: 912.9,
                },
                {
                    close: 912.48,
                    timestamp: '2025-02-08T10:08:00Z',
                    high: 913.51,
                    low: 912.16,
                    open: 912.86,
                },
                {
                    close: 912.11,
                    timestamp: '2025-02-08T10:09:00Z',
                    high: 913.82,
                    low: 912.11,
                    open: 912.63,
                },
                {
                    close: 914.52,
                    timestamp: '2025-02-08T10:10:00Z',
                    high: 914.52,
                    low: 912.3,
                    open: 912.31,
                },
                {
                    close: 916.45,
                    timestamp: '2025-02-08T10:11:00Z',
                    high: 916.51,
                    low: 913.6,
                    open: 914.59,
                },
                {
                    close: 915.36,
                    timestamp: '2025-02-08T10:12:00Z',
                    high: 916.28,
                    low: 913.77,
                    open: 916.28,
                },
                {
                    close: 915.48,
                    timestamp: '2025-02-08T10:13:00Z',
                    high: 916.22,
                    low: 914.66,
                    open: 915.47,
                },
                {
                    close: 914.29,
                    timestamp: '2025-02-08T10:14:00Z',
                    high: 915.41,
                    low: 914.0,
                    open: 915.35,
                },
                {
                    close: 915.19,
                    timestamp: '2025-02-08T10:15:00Z',
                    high: 916.68,
                    low: 914.27,
                    open: 914.64,
                },
                {
                    close: 914.85,
                    timestamp: '2025-02-08T10:16:00Z',
                    high: 915.9,
                    low: 914.4,
                    open: 915.23,
                },
                {
                    close: 915.92,
                    timestamp: '2025-02-08T10:17:00Z',
                    high: 916.41,
                    low: 914.37,
                    open: 915.1,
                },
                {
                    close: 916.29,
                    timestamp: '2025-02-08T10:18:00Z',
                    high: 916.46,
                    low: 915.47,
                    open: 916.24,
                },
                {
                    close: 918.86,
                    timestamp: '2025-02-08T10:19:00Z',
                    high: 918.95,
                    low: 915.78,
                    open: 916.08,
                },
                {
                    close: 919.56,
                    timestamp: '2025-02-08T10:20:00Z',
                    high: 919.59,
                    low: 918.4,
                    open: 918.99,
                },
                {
                    close: 922.13,
                    timestamp: '2025-02-08T10:21:00Z',
                    high: 922.13,
                    low: 919.05,
                    open: 919.63,
                },
                {
                    close: 920.94,
                    timestamp: '2025-02-08T10:22:00Z',
                    high: 922.38,
                    low: 920.53,
                    open: 921.98,
                },
                {
                    close: 919.57,
                    timestamp: '2025-02-08T10:23:00Z',
                    high: 921.09,
                    low: 918.95,
                    open: 920.77,
                },
                {
                    close: 918.83,
                    timestamp: '2025-02-08T10:24:00Z',
                    high: 919.74,
                    low: 918.22,
                    open: 919.74,
                },
                {
                    close: 917.91,
                    timestamp: '2025-02-08T10:25:00Z',
                    high: 919.81,
                    low: 917.83,
                    open: 918.99,
                },
                {
                    close: 915.75,
                    timestamp: '2025-02-08T10:26:00Z',
                    high: 918.01,
                    low: 915.04,
                    open: 918.01,
                },
                {
                    close: 915.21,
                    timestamp: '2025-02-08T10:27:00Z',
                    high: 915.91,
                    low: 914.79,
                    open: 915.82,
                },
                {
                    close: 915.41,
                    timestamp: '2025-02-08T10:28:00Z',
                    high: 915.82,
                    low: 914.48,
                    open: 914.91,
                },
                {
                    close: 914.37,
                    timestamp: '2025-02-08T10:29:00Z',
                    high: 915.9,
                    low: 914.34,
                    open: 915.28,
                },
                {
                    close: 912.82,
                    timestamp: '2025-02-08T10:30:00Z',
                    high: 914.91,
                    low: 912.52,
                    open: 914.63,
                },
                {
                    close: 913.92,
                    timestamp: '2025-02-08T10:31:00Z',
                    high: 914.1,
                    low: 912.67,
                    open: 912.92,
                },
                {
                    close: 914.91,
                    timestamp: '2025-02-08T10:32:00Z',
                    high: 916.15,
                    low: 913.91,
                    open: 914.02,
                },
                {
                    close: 914.25,
                    timestamp: '2025-02-08T10:33:00Z',
                    high: 915.39,
                    low: 913.93,
                    open: 915.0,
                },
                {
                    close: 914.3,
                    timestamp: '2025-02-08T10:34:00Z',
                    high: 914.55,
                    low: 913.34,
                    open: 914.25,
                },
                {
                    close: 914.46,
                    timestamp: '2025-02-08T10:35:00Z',
                    high: 914.91,
                    low: 914.06,
                    open: 914.61,
                },
                {
                    close: 915.22,
                    timestamp: '2025-02-08T10:36:00Z',
                    high: 915.71,
                    low: 914.27,
                    open: 914.27,
                },
                {
                    close: 914.73,
                    timestamp: '2025-02-08T10:37:00Z',
                    high: 916.05,
                    low: 914.64,
                    open: 915.1,
                },
                {
                    close: 917.48,
                    timestamp: '2025-02-08T10:38:00Z',
                    high: 917.6,
                    low: 914.33,
                    open: 914.99,
                },
                {
                    close: 918.26,
                    timestamp: '2025-02-08T10:39:00Z',
                    high: 918.57,
                    low: 916.76,
                    open: 917.18,
                },
                {
                    close: 918.45,
                    timestamp: '2025-02-08T10:40:00Z',
                    high: 919.1,
                    low: 917.99,
                    open: 918.44,
                },
                {
                    close: 918.62,
                    timestamp: '2025-02-08T10:41:00Z',
                    high: 918.77,
                    low: 917.94,
                    open: 918.48,
                },
                {
                    close: 918.39,
                    timestamp: '2025-02-08T10:42:00Z',
                    high: 918.52,
                    low: 917.58,
                    open: 918.52,
                },
                {
                    close: 918.69,
                    timestamp: '2025-02-08T10:43:00Z',
                    high: 919.69,
                    low: 917.64,
                    open: 918.25,
                },
                {
                    close: 917.95,
                    timestamp: '2025-02-08T10:44:00Z',
                    high: 919.41,
                    low: 917.46,
                    open: 918.76,
                },
                {
                    close: 919.66,
                    timestamp: '2025-02-08T10:45:00Z',
                    high: 920.46,
                    low: 917.77,
                    open: 918.19,
                },
                {
                    close: 919.47,
                    timestamp: '2025-02-08T10:46:00Z',
                    high: 920.37,
                    low: 919.18,
                    open: 919.91,
                },
                {
                    close: 917.94,
                    timestamp: '2025-02-08T10:47:00Z',
                    high: 919.93,
                    low: 917.48,
                    open: 919.86,
                },
                {
                    close: 918.03,
                    timestamp: '2025-02-08T10:48:00Z',
                    high: 918.42,
                    low: 917.5,
                    open: 917.95,
                },
                {
                    close: 918.58,
                    timestamp: '2025-02-08T10:49:00Z',
                    high: 918.96,
                    low: 917.0,
                    open: 917.99,
                },
                {
                    close: 918.4,
                    timestamp: '2025-02-08T10:50:00Z',
                    high: 919.4,
                    low: 918.25,
                    open: 918.54,
                },
                {
                    close: 919.2,
                    timestamp: '2025-02-08T10:51:00Z',
                    high: 919.92,
                    low: 918.28,
                    open: 918.49,
                },
                {
                    close: 920.03,
                    timestamp: '2025-02-08T10:52:00Z',
                    high: 920.03,
                    low: 918.41,
                    open: 918.86,
                },
                {
                    close: 921.27,
                    timestamp: '2025-02-08T10:53:00Z',
                    high: 921.65,
                    low: 920.43,
                    open: 920.43,
                },
                {
                    close: 924.29,
                    timestamp: '2025-02-08T10:54:00Z',
                    high: 924.33,
                    low: 921.36,
                    open: 921.39,
                },
                {
                    close: 921.84,
                    timestamp: '2025-02-08T10:55:00Z',
                    high: 924.16,
                    low: 921.59,
                    open: 924.16,
                },
                {
                    close: 921.73,
                    timestamp: '2025-02-08T10:56:00Z',
                    high: 923.33,
                    low: 921.47,
                    open: 921.89,
                },
                {
                    close: 923.34,
                    timestamp: '2025-02-08T10:57:00Z',
                    high: 923.34,
                    low: 921.29,
                    open: 921.77,
                },
                {
                    close: 923.19,
                    timestamp: '2025-02-08T10:58:00Z',
                    high: 924.74,
                    low: 922.8,
                    open: 923.27,
                },
                {
                    close: 922.74,
                    timestamp: '2025-02-08T10:59:00Z',
                    high: 923.63,
                    low: 922.44,
                    open: 922.98,
                },
                {
                    close: 922.14,
                    timestamp: '2025-02-08T11:00:00Z',
                    high: 922.72,
                    low: 921.91,
                    open: 922.69,
                },
                {
                    close: 922.41,
                    timestamp: '2025-02-08T11:01:00Z',
                    high: 922.75,
                    low: 921.5,
                    open: 922.12,
                },
                {
                    close: 923.26,
                    timestamp: '2025-02-08T11:02:00Z',
                    high: 923.59,
                    low: 922.38,
                    open: 922.38,
                },
                {
                    close: 923.63,
                    timestamp: '2025-02-08T11:03:00Z',
                    high: 924.48,
                    low: 923.06,
                    open: 923.19,
                },
                {
                    close: 923.62,
                    timestamp: '2025-02-08T11:04:00Z',
                    high: 923.76,
                    low: 922.59,
                    open: 923.76,
                },
                {
                    close: 923.94,
                    timestamp: '2025-02-08T11:05:00Z',
                    high: 925.21,
                    low: 923.6,
                    open: 923.6,
                },
                {
                    close: 924.26,
                    timestamp: '2025-02-08T11:06:00Z',
                    high: 924.59,
                    low: 923.19,
                    open: 923.79,
                },
                {
                    close: 926.36,
                    timestamp: '2025-02-08T11:07:00Z',
                    high: 926.4,
                    low: 923.74,
                    open: 924.11,
                },
                {
                    close: 924.93,
                    timestamp: '2025-02-08T11:08:00Z',
                    high: 926.63,
                    low: 924.77,
                    open: 926.38,
                },
                {
                    close: 928.41,
                    timestamp: '2025-02-08T11:09:00Z',
                    high: 928.55,
                    low: 925.04,
                    open: 925.04,
                },
                {
                    close: 927.24,
                    timestamp: '2025-02-08T11:10:00Z',
                    high: 928.75,
                    low: 926.91,
                    open: 928.61,
                },
                {
                    close: 927.09,
                    timestamp: '2025-02-08T11:11:00Z',
                    high: 927.4,
                    low: 926.47,
                    open: 927.25,
                },
                {
                    close: 926.45,
                    timestamp: '2025-02-08T11:12:00Z',
                    high: 927.44,
                    low: 926.2,
                    open: 927.1,
                },
            ]),
            echo_req: {
                adjust_start_time: 1,
                count: 1000,
                end: 'latest',
                granularity: 60,
                req_id: 41,
                style: 'candles',
                subscribe: 1,
                ticks_history: '1HZ100V',
            },
            pip_size: 2,
            req_id: 41,
            subscription: {
                id: 'adda2cb9-61de-6320-ab29-5136e904da38',
            },
        };


        setTimeout(() => {
            const quotes = TickHistoryFormatter.formatHistory(response);
            this.mainStore.chartAdapter.onTickHistory(quotes);
            this.loader.hide();

            // Start generating random data every second
            let lastPrice = 911.73; // Starting price
            setInterval(() => {
                const change = (Math.random() * 10 - 1) * 0.5; // Random change between -0.5 and 0.5
                lastPrice += change;
                
                const data = {
                    type: 'tick' as const,
                    instrument_id: '1HZ100V',
                    quote: lastPrice,
                    timestamp: new Date().toISOString()
                };
                
                this.onStreamingData(data);
            }, 1000);
        }, 1000);
    };

    _initChart(rootNode: HTMLElement | null, props: React.PropsWithChildren<TChartProps>) {
        this.rootNode = rootNode as HTMLElement | null;

        this.chartNode = this.rootNode?.querySelector('.ciq-chart-area');

        this.chartControlsNode = this.rootNode?.querySelector('.cq-chart-controls');

        const {
            symbol,
            granularity,
            requestAPI,
            requestSubscribe,
            requestForget,
            requestForgetStream,
            isMobile,
            enableRouting,
            onMessage,
            settings,
            onSettingsChange,
            getMarketsOrder,
            initialData,
            chartData,
            feedCall,
            isLive,
            startWithDataFitMode,
            leftMargin,
        } = props;
        this.feedCall = feedCall || {};
        this.api = new BinaryAPI(requestAPI, requestSubscribe, requestForget, requestForgetStream);
        this.currentLanguage = localStorage.getItem('current_chart_lang') ?? settings?.language?.toLowerCase();
        // trading times and active symbols can be reused across multiple charts
        this.tradingTimes =
            ChartStore.tradingTimes ||
            (ChartStore.tradingTimes = new TradingTimes(this.api, {
                enable: this.feedCall.tradingTimes,
                shouldFetchTradingTimes: this.mainStore.state.shouldFetchTradingTimes,
                tradingTimes: initialData?.tradingTimes,
            }));
        this.activeSymbols =
            (this.currentLanguage === settings?.language && ChartStore.activeSymbols) ||
            (ChartStore.activeSymbols = new ActiveSymbols(this.api, this.tradingTimes, {
                enable: this.feedCall.activeSymbols,
                getMarketsOrder,
                activeSymbols: initialData?.activeSymbols,
                chartData,
            }));
        const { chartSetting } = this.mainStore;
        chartSetting.setSettings(settings);
        chartSetting.onSettingsChange = onSettingsChange;
        this.isMobile = isMobile;
        this.whitespace = isMobile ? 50 : 150;
        this.state = this.mainStore.state;
        this.mainStore.notifier.onMessage = onMessage;
        this.granularity = granularity !== undefined ? granularity : this.defaults.granularity;
        this.isLive = isLive || false;
        this.startWithDataFitMode = startWithDataFitMode || false;
        this.leftMargin = leftMargin;

        ChartStore.chartCount += 1;

        // connect chart to data
        this.feed = new Feed(this.api, this.mainStore, this.tradingTimes);
        this.enableRouting = enableRouting;
        if (this.enableRouting) {
            this.routingStore.handleRouting();
        }
        const context = new Context(this.rootNode);
        this.stateStore.stateChange(STATE.INITIAL);
        this.loader.setState('market-symbol');
        this.activeSymbols?.retrieveActiveSymbols().then(() => {
            this.loader.setState('trading-time');
            this.tradingTimes?.initialize().then(
                action(() => {
                    // In the odd event that chart is destroyed by the time
                    // the request finishes, just calmly return...
                    if (this.isDestroyed) {
                        return;
                    }
                    if (this.startWithDataFitMode) {
                        this.state?.clearLayout();
                    } else {
                        this.state?.restoreLayout();
                    }

                    let _symbol = this.state?.symbol || symbol;

                    this.changeSymbol(
                        // default to first available symbol
                        _symbol || (this.activeSymbols && Object.keys(this.activeSymbols.symbolMap)[0]),
                        this.granularity
                    );
                    this.context = context;
                    this.chartClosedOpenThemeChange(!this.currentActiveSymbol?.exchange_is_open);
                    this.mainStore.chart.tradingTimes?.onMarketOpenCloseChanged(
                        action((changes: TChanges) => {
                            for (const sy in changes) {
                                if (this.currentActiveSymbol?.symbol === sy) {
                                    this.chartClosedOpenThemeChange(!changes[sy]);
                                }
                            }
                        })
                    );

                    this.contextPromise?.resolve?.(this.context);
                    this.resizeScreen();

                    reaction(
                        () => [this.state?.symbol, this.state?.granularity],
                        () => {
                            if (this.state?.symbol !== undefined || this.state?.granularity !== undefined) {
                                this.changeSymbol(this.state.symbol, this.state.granularity);
                            }
                        }
                    );
                    this.tradingTimes?.onTimeChanged(this.onServerTimeChange);
                    setTimeout(
                        action(() => {
                            // Defer the render of the dialogs and dropdowns; this enables
                            // considerable performance improvements for slower devices.
                            this.shouldRenderDialogs = true;
                        }),
                        500
                    );
                })
            );
        });
    }
    setResizeEvent = () => {
        const listener = (entries: ResizeObserverEntry[]) => {
            entries.forEach(() => {
                if (this.rootNode && this.rootNode.clientWidth > 0) this.resizeScreen();
            });
        };
        if ('ResizeObserver' in window) {
            this.resizeObserver = new ResizeObserver(listener);
            if (this.rootNode) this.resizeObserver.observe(this.rootNode);
        } else {
            import(/* webpackChunkName: "resize-observer-polyfill" */ 'resize-observer-polyfill').then(
                ({ default: ResizeObserver }) => {
                    window.ResizeObserver = ResizeObserver;

                    if (!this.rootNode) {
                        return;
                    }
                    this.resizeObserver = new ResizeObserver(listener);
                    this.resizeObserver.observe(this.rootNode);
                }
            );
        }
    };
    onMarketOpenClosedChange = (changes: TChanges) => {
        const symbolObjects = this.activeSymbols?.processedSymbols || [];
        let shouldRefreshChart = false;
        for (const { symbol, name } of symbolObjects) {
            if (symbol in changes) {
                if (changes[symbol]) {
                    shouldRefreshChart = true;
                    this.chartClosedOpenThemeChange(false);
                    this.mainStore.notifier.notifyMarketOpen(name);
                } else {
                    this.chartClosedOpenThemeChange(true);
                    this.mainStore.notifier.notifyMarketClose(name);
                }
            }
        }
        if (shouldRefreshChart) {
            // refresh to stream opened market
            this.refreshChart();
        }
    };

    chartClosedOpenThemeChange(isChartClosed: boolean) {
        this.mainStore.state.setChartClosed(isChartClosed);
        this.mainStore.state.setChartTheme(this.mainStore.chartSetting.theme);
        this.mainStore.chartAdapter.setSymbolClosed(isChartClosed);
    }
    get categorizedSymbols() {
        if (!this.activeSymbols || this.activeSymbols.categorizedSymbols.length === 0) return [];
        const activeSymbols = this.activeSymbols.activeSymbols;
        return cloneCategories<TSubCategoryDataItem>(activeSymbols, item => {
            const selected = (item as TSubCategoryDataItem).dataObject.symbol === this.currentActiveSymbol?.symbol;
            return {
                ...item,
                selected,
            };
        });
    }
    onServerTimeChange() {
        if (this.tradingTimes?._serverTime) {
            this.serverTime = moment(this.tradingTimes._serverTime.getEpoch() * 1000).format(
                'DD MMM YYYY HH:mm:ss [GMT]'
            );
        }
    }

    updateCurrentActiveSymbol(symbolObj: TProcessedSymbolItem) {
        this.currentActiveSymbol = symbolObj;
    }
    setChartAvailability(status: boolean) {
        this.isChartAvailable = status;
    }
    changeSymbol(
        symbolObj: TProcessedSymbolItem | string | undefined,
        granularity?: TGranularity,
        isLanguageChanged = false
    ) {
        if (typeof symbolObj === 'string') {
            symbolObj = this.activeSymbols?.getSymbolObj(symbolObj);
        }
        const isSymbolAvailable = symbolObj && this.currentActiveSymbol;
        if (
            isSymbolAvailable &&
            symbolObj?.symbol === this.currentActiveSymbol?.symbol &&
            granularity !== undefined &&
            granularity === this.granularity &&
            !isLanguageChanged
        ) {
            return;
        }

        this.newChart(symbolObj);

        if (granularity !== undefined) {
            this.granularity = granularity;
        }

        if (symbolObj) {
            this.updateCurrentActiveSymbol(symbolObj);
        }
    }
    // Calling newChart with symbolObj as undefined refreshes the chart
    newChart(symbolObj = this.currentActiveSymbol) {
        if (!symbolObj) return;

        if (this.currentActiveSymbol) {
            this.feed?.unsubscribe({ symbol: this.currentActiveSymbol.symbol, granularity: this.granularity });
        }

        this.loader.show();
        this.mainStore.state.setChartIsReady(false);
        const onChartLoad = (err: string) => {
            this.loader.hide();
            this.chartClosedOpenThemeChange(!symbolObj.exchange_is_open);
            this.mainStore.paginationLoader.updateOnPagination(false);

            this.mainStore.state.setChartIsReady(true);

            if (err) {
                /* TODO, symbol not found error */
                return;
            }
        };

        this.mainStore.chartAdapter.newChart();
        this.feed?.fetchInitialData(
            symbolObj.symbol,
            {
                granularity: this.mainStore.state.granularity,
                symbolObject: symbolObj,
            },
            ({ quotes, error }: TPaginationCallbackParams) => {
                this.mainStore.chartAdapter.onTickHistory(quotes || []);
                this.mainStore.chart.feed?.offMasterDataUpdate(this.mainStore.chartAdapter.onTick);
                this.mainStore.chart.feed?.onMasterDataUpdate(this.mainStore.chartAdapter.onTick);
                onChartLoad(error as string);
            }
        );
    }

    remainLabelY = (): number => {
        return 0;
    };

    updateScaledOneOne(state: boolean) {
        this.isScaledOneOne = state;
    }
    // Makes requests to tick history API that will replace
    // Existing chart tick/ohlc data
    refreshChart() {
        this.newChart();
    }
    destroy() {
        ChartStore.chartCount -= 1;
        this.isDestroyed = true;
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (this.tradingTimes && ChartStore.chartCount === 0) {
            ChartStore.tradingTimes = null;
            this.tradingTimes.destructor();
        }
        // Destroying the chart does not unsubscribe the streams;
        // we need to manually unsubscribe them.
        if (this.feed) {
            this.feed.unsubscribeAll();
            this.feed = null;
        }

        this.mainStore.drawTools.destructor();
        this.currentActiveSymbol = null;
        this.contextPromise = null;
        this.context = null;
    }

    openFullscreen() {
        const fullscreen_map: Record<string, string[]> = {
            element: ['fullscreenElement', 'webkitFullscreenElement', 'mozFullScreenElement', 'msFullscreenElement'],
            fnc_enter: ['requestFullscreen', 'webkitRequestFullscreen', 'mozRequestFullScreen', 'msRequestFullscreen'],
            fnc_exit: ['exitFullscreen', 'webkitExitFullscreen', 'mozCancelFullScreen', 'msExitFullscreen'],
        };
        const isInFullScreen = fullscreen_map.element.some(
            fnc => document[fnc as keyof Document] && document[fnc as keyof Document] !== null
        );
        const el = isInFullScreen ? document : document.documentElement;
        const fncToCall = fullscreen_map[isInFullScreen ? 'fnc_exit' : 'fnc_enter'].find(
            fnc => (el as HTMLElement)[fnc as keyof HTMLElement]
        );
        // fncToCall can be undefined for iOS that does not support fullscreenAPI
        if (fncToCall) {
            (el as HTMLElement)[fncToCall as 'requestFullscreen']()?.catch(() => undefined);
        }
    }
}
export default ChartStore;
