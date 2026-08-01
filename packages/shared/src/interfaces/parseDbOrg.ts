import type { Organization } from "../db/types.js";
import { CloudConfigSchema } from "./cloudConfigSchema";

export type ParsedOrganization = Omit<Organization, "cloudConfig"> & {
  cloudConfig: CloudConfigSchema | null;
};

export function parseDbOrg(dbOrg: Organization): ParsedOrganization {
  const { cloudConfig, ...org } = dbOrg;

  const parsedCloudConfig = CloudConfigSchema.safeParse(cloudConfig);

  const parsedOrg = {
    ...org,
    cloudConfig: parsedCloudConfig.success ? parsedCloudConfig.data : null,
  };

  return parsedOrg;
}
