import originAxios, { isAxiosError } from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import { httpsOverHttp, httpOverHttp } from 'tunnel-agent';

import { config } from '../config.ts';
const Config = config;

/** Per-request retry overrides; `retryGet` fills the rest from config.ts. */
export interface RetryPolicy {
  limit?: number;
  retryCount?: number;
  retryDelay?: number;
  timeout?: number;
}

/** A request config that also carries the retry policy. */
export interface RetryOptions extends AxiosRequestConfig {
  retry?: RetryPolicy;
}

const axios = originAxios.create();
// axios.defaults.timeout = Config.timeout || 2000; // 请求超时的毫秒数
// // 拦截请求 (添加自定义默认参数)
// axios.interceptors.request.use(function (config) {
//   config.retry = Config.retry || 5; // 重试次数
//   config.retryDelay = Config.retryDelay || 1000; // 请求间隔的毫秒数
//   return config;
// });

// 代理设置
const TUNNEL_OPTIONS: { proxy: { host?: string; port: number } } = {
  proxy: {
    port: Config.httpProxyPort
  }
};
if (Config.httpProxyHost) {
  TUNNEL_OPTIONS.proxy.host = Config.httpProxyHost;
}

// 拦截请求 (http 代理)
axios.interceptors.request.use(function (config) {
  if (Config.httpProxyPort) {
    config.proxy = false; // 强制禁用环境变量中的代理配置
    config.httpAgent = httpOverHttp(TUNNEL_OPTIONS);
    config.httpsAgent = httpsOverHttp(TUNNEL_OPTIONS);
  }

  return config;
});

// // 拦截响应 (遇到错误时, 重新发起新请求)
// axios.interceptors.response.use(undefined, function axiosRetryInterceptor(err) {
//   var config = err.config;
//   // If config does not exist or the retry option is not set, reject
//   if(!config || !config.retry) return Promise.reject(err);
  
//   // Set the variable for keeping track of the retry count
//   config.__retryCount = config.__retryCount || 0;
  
//   // Check if we've maxed out the total number of retries
//   if(config.__retryCount >= config.retry) {
//     // Reject with the error
//     return Promise.reject(err);
//   }
  
//   // Increase the retry count
//   config.__retryCount += 1;

//   // Create new promise to handle exponential backoff
//   var backoff = new Promise(function(resolve) {
//     setTimeout(function() {
//         resolve();
//     }, config.retryDelay || 1);
//   });
  
//   // Return the promise in which recalls axios to retry the request
//   return backoff.then(function() {
//     return axios(config);
//   });
// });




const retryGet = async <T = unknown>(url: string, config: RetryOptions): Promise<AxiosResponse<T>> => {
  let defaultLimit = Config.retry || 5;
  let defaultRetryDelay = Config.retryDelay || 2000;
  let defaultTimeout = 10000;

  if (url.indexOf('dlsite') !== -1) {
    defaultTimeout = Config.dlsiteTimeout || defaultLimit;
  } else if (url.indexOf('hvdb') !== -1) {
    defaultTimeout = Config.hvdbTimeout || defaultLimit;
  } else if (url.indexOf('dmm.co.jp') !== -1) {
    defaultTimeout = Config.fanzaTimeout || defaultLimit;
  }

  const retry = {
    limit: config.retry?.limit || defaultLimit, // 5
    retryCount: config.retry?.retryCount || 0,
    retryDelay: config.retry?.retryDelay || defaultRetryDelay, //2000,
    timeout: config.retry?.timeout || defaultTimeout
  };
  config.retry = retry;

  const abort = originAxios.CancelToken.source();
  const timeoutId = setTimeout(
    () => abort.cancel(`Timeout of ${retry.timeout}ms.`),
    retry.timeout
  );
  config.cancelToken = abort.token;

  try {
    const response = await axios.get<T>(url, config);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    const backoff = new Promise<void>((resolve) => {
      setTimeout(() => resolve(), retry.retryDelay);
    });

    if (retry.retryCount < retry.limit && !(isAxiosError(error) && error.response)) {
      retry.retryCount += 1;
      await backoff;
      console.log(`${url} 第 ${retry.retryCount} 次重试请求`);
      return retryGet<T>(url, config);
    } else {
      throw error;
    }
  }
};

// The instance gains `retryGet` at module load, exactly as before; Object.assign
// is a property assignment that hands the same instance back.
export default Object.assign(axios, { retryGet });
