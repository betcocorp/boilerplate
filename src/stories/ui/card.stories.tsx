import type { Meta, StoryObj } from '@storybook/nextjs';

import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';

const meta = { title: 'ui/Card', component: Card } satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-96">
      <CardHeader>
        <CardTitle>Card title</CardTitle>
        <CardDescription>Supporting description.</CardDescription>
      </CardHeader>
      <CardContent>Card content goes here.</CardContent>
      <CardFooter>
        <Button size="sm">Action</Button>
      </CardFooter>
    </Card>
  ),
};
