import type { Meta, StoryObj } from '@storybook/nextjs';

import { Avatar, AvatarFallback } from '~/components/ui/avatar';

const meta = { title: 'ui/Avatar', component: Avatar } satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fallback: Story = {
  render: (args) => (
    <Avatar {...args}>
      <AvatarFallback>BC</AvatarFallback>
    </Avatar>
  ),
};
