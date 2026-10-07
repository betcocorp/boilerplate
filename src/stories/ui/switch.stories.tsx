import type { Meta, StoryObj } from '@storybook/nextjs';

import { Label } from '~/components/ui/label';
import { Switch } from '~/components/ui/switch';

const meta = { title: 'ui/Switch', component: Switch } satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="flex items-center gap-2">
      <Switch {...args} id="notify" />
      <Label htmlFor="notify">Notifications</Label>
    </div>
  ),
};
export const On: Story = { args: { defaultChecked: true } };
export const Disabled: Story = { args: { disabled: true } };
