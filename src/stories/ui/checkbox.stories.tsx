import type { Meta, StoryObj } from '@storybook/nextjs';

import { Checkbox } from '~/components/ui/checkbox';
import { Label } from '~/components/ui/label';

const meta = { title: 'ui/Checkbox', component: Checkbox } satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="flex items-center gap-2">
      <Checkbox {...args} id="terms" />
      <Label htmlFor="terms">Accept terms</Label>
    </div>
  ),
};
export const Checked: Story = { args: { defaultChecked: true } };
export const Disabled: Story = { args: { disabled: true } };
