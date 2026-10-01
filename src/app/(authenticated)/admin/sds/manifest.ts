export type SdsSeedDocument = {
  id: string;
  title: string;
  productCode: string | null;
  s3Key: string;
  locale: string;
};

export const SDS_S3_BUCKET_DEFAULT = 'betco-sds';
export const SDS_S3_PREFIX_DEFAULT = '';

/**
 * Optional per-file metadata overrides keyed by normalized relative path
 * (lowercase, forward slashes, rooted at SDS_S3_PREFIX_DEFAULT or SDS_S3_PREFIX).
 */
export const SDS_FILE_OVERRIDES: Record<
  string,
  Partial<Pick<SdsSeedDocument, 'title' | 'productCode' | 'locale'>>
> = {
  'prop 65/110.pdf': {
    title: 'Prop 65 - 110',
    productCode: '110',
    locale: 'EN',
  },
  'werscsmart sds/090 w.pdf': {
    title: 'WERCS Smart SDS - 090 W',
    productCode: '090W',
    locale: 'EN',
  },
  'envirozyme sds/biowish/sds_aqua fog 1199-03-en.pdf': {
    title: 'EnviroZyme BioWish Aqua FOG 1199-03 EN',
    productCode: '1199-03',
    locale: 'EN',
  },
  'battery sds/rbattcc_alkaline battery mercury free_rayovac.pdf': {
    title: 'RayOVac Alkaline Battery Mercury Free',
    productCode: 'RBATTCC',
    locale: 'EN',
  },
  'basic sds/b0657.pdf': {
    title: 'Basic SDS B0657',
    productCode: 'B0657',
    locale: 'EN',
  },
  'basic sds/basic diluted sds/b0695 dil.pdf': {
    title: 'Basic SDS B0695 DIL',
    productCode: 'B0695',
    locale: 'EN',
  },
  'basic sds/archive basic coatings/b0626fr.pdf': {
    title: 'Basic SDS B0626FR',
    productCode: 'B0626FR',
    locale: 'FR',
  },
  '1950 sds/2607 (multipurpose enzyme cleaner).pdf': {
    title: 'Velocity 2607 Multipurpose Enzyme Cleaner',
    productCode: '2607',
    locale: 'EN',
  },
};
