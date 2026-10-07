import type { Meta, StoryObj } from '@storybook/nextjs';

import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';

const meta = {
  title: 'ui/Alert',
  component: Alert,
  render: (args) => (
    <Alert {...args} className="w-96">
      <AlertTitle>Heads up</AlertTitle>
      <AlertDescription>Something worth knowing happened.</AlertDescription>
    </Alert>
  ),
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Destructive: Story = { args: { variant: 'destructive' } };
