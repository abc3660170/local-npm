import axios from "axios";
const axiosInstance = axios.create({
  baseURL: "/", // 设置基础路径
  timeout: 10000,   // 设置超时时间
});

// 响应拦截器
axiosInstance.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    throw error;
  }
);

export default axiosInstance;