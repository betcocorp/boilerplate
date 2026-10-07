import type { Meta, StoryObj } from '@storybook/nextjs';

import { Separator } from '~/components/ui/separator';

const meta = { title: 'ui/Separator', component: Separator } satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="w-72">
      <p className="text-sm">Above</p>
      <Separator className="my-3" />
      <p className="text-sm">Below</p>
    </div>
  ),
};
