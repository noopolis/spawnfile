import { DAIMON_GATEWAY_URL_ENV } from "../gateway.js";
import { isDaimonGatewayRealmMountId } from "../subscriptionRealms.js";

export const daimonExternalMountEnvironment = (id: string): string | undefined =>
  isDaimonGatewayRealmMountId(id) ? DAIMON_GATEWAY_URL_ENV : undefined;
