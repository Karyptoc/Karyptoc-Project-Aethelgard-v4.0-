'use strict';
// Single entry point for the new strategy engine.
module.exports = {
  ...require('./config/instruments'),
  clock: require('./sessionClock'),
  noiseArea: require('./strategies/noiseArea'),
  trendEnsemble: require('./strategies/trendEnsemble'),
  risk: require('./riskLayer'),
  admin: require('./adminSettings'),
  adminRouter: () => require('./adminRoutes'),
};
