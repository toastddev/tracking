export { initFirestore, db } from './config';
export { COLLECTIONS, type CollectionName } from './schema';
export { INDEXES } from './indexes';
export { offerRepository } from './repositories/offerRepository';
export { networkRepository } from './repositories/networkRepository';
export { clickRepository } from './repositories/clickRepository';
export { conversionRepository } from './repositories/conversionRepository';
export { offerReportRepository } from './repositories/offerReportRepository';
export type { OfferReportDoc } from './repositories/offerReportRepository';
export { campaignReportRepository } from './repositories/campaignReportRepository';
export type { CampaignReportDoc, CampaignSource } from './repositories/campaignReportRepository';
export { googleAdsConnectionRepository } from './repositories/googleAdsConnectionRepository';
export { googleAdsMccChildrenRepository, buildMccChildId } from './repositories/googleAdsMccChildrenRepository';
export { googleAdsRouteRepository, buildRouteId } from './repositories/googleAdsRouteRepository';
export { googleAdsUploadRepository } from './repositories/googleAdsUploadRepository';
export { googleAdsSyncStateRepository } from './repositories/googleAdsSyncStateRepository';
export type { GoogleAdsSyncState } from './repositories/googleAdsSyncStateRepository';
// Facebook (Meta) integration repositories — parallel to the GAds repos above.
export { facebookConnectionRepository } from './repositories/facebookConnectionRepository';
export { facebookBusinessChildrenRepository, buildFbChildId } from './repositories/facebookBusinessChildrenRepository';
export { facebookRouteRepository, buildFbRouteId } from './repositories/facebookRouteRepository';
export { facebookUploadRepository } from './repositories/facebookUploadRepository';
export { facebookSyncStateRepository } from './repositories/facebookSyncStateRepository';
export type { FacebookSyncState } from './repositories/facebookSyncStateRepository';
export { facebookOauthSessionRepository } from './repositories/facebookOauthSessionRepository';
export type { FacebookOauthSessionDoc } from './repositories/facebookOauthSessionRepository';
export {
  facebookCampaignReportRepository,
  NO_MATCH_CAMPAIGN_ID,
  NO_MATCH_CAMPAIGN_NAME,
} from './repositories/facebookCampaignReportRepository';
export type {
  FacebookCampaignReportDoc,
  FacebookCampaignSource,
  FbIncrementClickInput,
  FbIncrementConversionInput,
} from './repositories/facebookCampaignReportRepository';
export {
  affiliateApiRepository,
  affiliateApiRunRepository,
} from './repositories/affiliateApiRepository';
export { drilldownRepository } from './repositories/drilldownRepository';
export type { OfferDrilldownDoc, PostbackDrilldownDoc } from './repositories/drilldownRepository';
