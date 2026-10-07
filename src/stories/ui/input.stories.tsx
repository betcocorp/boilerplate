import type { Meta, StoryObj } from '@storybook/nextjs';

import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';

const meta = {
  title: 'ui/Input',
  component: Input,
  args: { placeholder: 'Type here…' },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
export const WithLabel: Story = {
  render: (args) => (
    <div className="grid w-72 gap-2">
      <Label htmlFor="email">Email</Label>
      <Input {...args} id="email" type="email" />
    </div>
  ),
};
