import type { Meta, StoryObj } from '@storybook/nextjs';

import { Slider } from '~/components/ui/slider';

const meta = {
  title: 'ui/Slider',
  component: Slider,
  args: { defaultValue: [40], max: 100, step: 1, className: 'w-72' },
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
