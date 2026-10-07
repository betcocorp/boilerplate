import type { Meta, StoryObj } from '@storybook/nextjs';

import { Toggle } from '~/components/ui/toggle';

const meta = {
  title: 'ui/Toggle',
  component: Toggle,
  args: { children: 'Toggle' },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Outline: Story = { args: { variant: 'outline' } };
