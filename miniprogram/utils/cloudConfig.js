// 本地编译/下一次发版使用的入口；不会改变已发布的小程序包。
// 应急旧接口路由：同时改回 app / login，再重新编译；旧 app 不支持 publishAiPlan。
// 完整发版回退需配套原前端版本。不要在请求失败时自动切后端。
module.exports = Object.freeze({
  env: 'cloud1-d5gz9j6zh654f4b36',
  functions: Object.freeze({ app: 'app-node24', login: 'login-node24' }),
});
