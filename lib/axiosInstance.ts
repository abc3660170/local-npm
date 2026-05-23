import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import http from "http";
import https from "https";

// 共享 keep-alive 连接池：高并发下避免 socket 耗尽
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

// 上游请求重试：只重试网络错误 / 5xx / 408 / 429；其他 4xx 直接放行
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 300;

interface RetryConfig extends InternalAxiosRequestConfig {
  __retryCount?: number;
}

const axiosInstance = axios.create({
  baseURL: "/",
  timeout: 60000,
  httpAgent,
  httpsAgent,
});

axiosInstance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetryConfig | undefined;
    if (!config) throw error;

    const status = error.response?.status;
    const transient =
      !error.response ||
      (typeof status === "number" && (status >= 500 || status === 408 || status === 429));

    config.__retryCount = config.__retryCount ?? 0;
    if (transient && config.__retryCount < RETRY_ATTEMPTS - 1) {
      config.__retryCount++;
      const delay = RETRY_BASE_MS * Math.pow(2, config.__retryCount - 1);
      await new Promise((r) => setTimeout(r, delay));
      return axiosInstance.request(config);
    }
    throw error;
  }
);

export default axiosInstance;
