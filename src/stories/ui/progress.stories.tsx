import type { Meta, StoryObj } from '@storybook/nextjs';

import { Progress } from '~/components/ui/progress';

const meta = {
  title: 'ui/Progress',
  component: Progress,
  args: { value: 60, className: 'w-72' },
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
