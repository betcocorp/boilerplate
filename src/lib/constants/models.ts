export type SupportedModel = {
  name: string;
  label: string;
};

const supportedModels: SupportedModel[] = [
  {
    name: 'gpt-4o',
    label: 'Model: gpt-4o',
  },
  {
    name: 'gpt-4.1-mini',
    label: 'Model: gpt-4.1-mini',
  },
  {
    name: 'gpt-4.1',
    label: 'Model: gpt-4.1',
  },
  { name: 'gpt-5.5', label: 'Model: gpt-5.5' },
  { name: 'gpt-5.6', label: 'Model: gpt-5.6' },
];

export default supportedModels;
