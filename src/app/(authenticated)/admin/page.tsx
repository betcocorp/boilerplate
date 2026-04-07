import Link from 'next/link';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Ellipsis,
  Plus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

import { Avatar, AvatarFallback, AvatarGroup } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import { Separator } from '~/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';

const metrics = [
  {
    title: 'Total Revenue',
    value: '$1,250.00',
    delta: '+12.5%',
    trend: 'up',
    summary: 'Trending up this month',
    detail: 'Visitors for the last 6 months',
  },
  {
    title: 'New Customers',
    value: '1,234',
    delta: '-20%',
    trend: 'down',
    summary: 'Down 20% this period',
    detail: 'Acquisition needs attention',
  },
  {
    title: 'Active Accounts',
    value: '45,678',
    delta: '+12.5%',
    trend: 'up',
    summary: 'Strong user retention',
    detail: 'Engagement exceed targets',
  },
  {
    title: 'Growth Rate',
    value: '4.5%',
    delta: '+4.5%',
    trend: 'up',
    summary: 'Steady performance increase',
    detail: 'Meets growth projections',
  },
];

const visitors = [42, 68, 34, 58, 78, 96, 62, 88, 52, 74, 110, 84];

const outlineTabs = [
  { label: 'Outline', value: 'outline' },
  { label: 'Past Performance', value: 'past-performance', badge: '3' },
  { label: 'Key Personnel', value: 'key-personnel', badge: '2' },
  { label: 'Focus Documents', value: 'focus-documents' },
];

const rows = [
  ['Cover page', 'Cover page', 'In Process', 'Eddie Lake'],
  ['Table of contents', 'Table of contents', 'Done', 'Eddie Lake'],
  ['Executive summary', 'Narrative', 'Done', 'Eddie Lake'],
  ['Technical approach', 'Narrative', 'Done', 'Jamik Tashpulatov'],
  ['Design', 'Narrative', 'In Process', 'Jamik Tashpulatov'],
  ['Capabilities', 'Narrative', 'In Process', 'Jamik Tashpulatov'],
  ['Integration with existing systems', 'Narrative', 'In Process', 'Jamik Tashpulatov'],
  ['Innovation and Advantages', 'Narrative', 'Done', 'Assign reviewer'],
  ['Overview of EMR\'s Innovative Solutions', 'Technical content', 'Done', 'Assign reviewer'],
  ['Advanced Algorithms and Machine Learning', 'Narrative', 'Done', 'Assign reviewer'],
];

function MetricCard({
  detail,
  delta,
  summary,
  title,
  trend,
  value,
}: (typeof metrics)[number]) {
  const isUp = trend === 'up';
  const TrendIcon = isUp ? TrendingUp : TrendingDown;

  return (
    <Card className="gap-4 rounded-3xl border border-border/60 shadow-none">
      <CardHeader className="px-5 pb-0">
        <CardDescription>{title}</CardDescription>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-3xl font-semibold">{value}</CardTitle>
          <Badge
            className={
              isUp
                ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-50'
                : 'bg-rose-50 text-rose-700 hover:bg-rose-50'
            }
            variant="secondary"
          >
            <TrendIcon className="size-3.5" />
            {delta}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-1 px-5 pt-0 text-sm">
        <p className="font-medium text-foreground">{summary}</p>
        <p className="text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function VisitorsChart() {
  const maxValue = Math.max(...visitors);

  return (
    <div className="mt-8">
      <div className="flex h-60 items-end gap-2">
        {visitors.map((value, index) => (
          <div
            className="flex-1 rounded-t-2xl bg-primary/15"
            key={index}
            style={{ height: `${(value / maxValue) * 100}%` }}
          >
            <div
              className="w-full rounded-t-2xl bg-primary/80"
              style={{ height: `${Math.max((value / maxValue) * 100 - 18, 16)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-between text-xs text-muted-foreground">
        <span>Jan</span>
        <span>Feb</span>
        <span>Mar</span>
        <span>Apr</span>
        <span>May</span>
        <span>Jun</span>
      </div>
    </div>
  );
}

export default function AdminDashboardPage() {
  return (
    <main className="min-w-0 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background shadow-sm">
        <div className="flex items-center justify-between gap-4 px-6 py-5 sm:px-8">
          <div>
            <p className="text-sm text-muted-foreground">Dashboard</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Documents</h1>
          </div>
          <div className="flex items-center gap-3">
            <AvatarGroup>
              {['EL', 'JT', 'CN'].map((initials) => (
                <Avatar key={initials}>
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              ))}
            </AvatarGroup>
            <Button className="rounded-2xl" size="lg">
              <Plus className="size-4" />
              Quick Create
            </Button>
          </div>
        </div>

        <Separator />

        <div className="space-y-6 px-6 py-6 sm:px-8">
          <section className="grid gap-4 xl:grid-cols-4">
            {metrics.map((metric) => (
              <MetricCard key={metric.title} {...metric} />
            ))}
          </section>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
            <Card className="rounded-3xl border border-border/60 shadow-none">
              <CardHeader className="flex flex-row items-start justify-between gap-4 px-5 pb-0">
                <div>
                  <CardTitle className="text-lg font-semibold">Total Visitors</CardTitle>
                  <CardDescription>Total for the last 3 months</CardDescription>
                </div>
                <Button className="rounded-2xl" size="sm" variant="outline">
                  Last 3 months
                  <ChevronDown className="size-4" />
                </Button>
              </CardHeader>
              <CardContent className="px-5 pt-0">
                <VisitorsChart />
              </CardContent>
            </Card>

            <Card className="rounded-3xl border border-border/60 shadow-none">
              <CardHeader className="px-5 pb-0">
                <CardTitle className="text-lg font-semibold">Outline</CardTitle>
                <CardDescription>
                  Keep the current product admin pages under Documents while you
                  expand the RAG pipeline.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 px-5 pt-0">
                <Tabs defaultValue="outline">
                  <TabsList className="w-full justify-start gap-2 rounded-2xl bg-muted/70 p-1">
                    {outlineTabs.map((tab) => (
                      <TabsTrigger
                        className="rounded-2xl px-3"
                        key={tab.value}
                        value={tab.value}
                      >
                        {tab.label}
                        {tab.badge ? (
                          <span className="rounded-full bg-background px-2 py-0.5 text-xs">
                            {tab.badge}
                          </span>
                        ) : null}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                <div className="rounded-3xl bg-muted/60 p-4">
                  <p className="text-sm font-medium text-foreground">
                    Current admin shortcuts
                  </p>
                  <div className="mt-4 grid gap-3">
                    {[
                      ['Bex chat', '/admin/bex'],
                      ['Legacy product browser', '/admin/products/legacy'],
                      ['RAG product browser', '/admin/products/rag'],
                      ['RAG generation', '/admin/products/rag/generate'],
                      ['Semantic search', '/admin/products/rag/search'],
                    ].map(([label, href]) => (
                      <Link
                        className="flex items-center justify-between rounded-2xl bg-background px-4 py-3 text-sm font-medium text-foreground transition hover:bg-accent"
                        href={href}
                        key={label}
                      >
                        <span>{label}</span>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </Link>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="rounded-3xl border border-border/60 bg-card shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-5">
              <div className="flex items-center gap-2">
                <Button className="rounded-2xl" size="sm" variant="outline">
                  Customize Columns
                </Button>
                <Button className="rounded-2xl" size="sm" variant="outline">
                  Columns
                  <ChevronDown className="size-4" />
                </Button>
              </div>
              <Button className="rounded-2xl" size="sm">
                <Plus className="size-4" />
                Add Section
              </Button>
            </div>

            <Table>
              <TableHeader>
                <TableRow className="border-border/60 hover:bg-transparent">
                  <TableHead>Header</TableHead>
                  <TableHead>Section Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reviewer</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(([header, type, status, reviewer]) => (
                  <TableRow className="border-border/60" key={header}>
                    <TableCell className="font-medium">{header}</TableCell>
                    <TableCell>{type}</TableCell>
                    <TableCell>
                      <Badge
                        className={
                          status === 'Done'
                            ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-50'
                            : 'bg-amber-50 text-amber-700 hover:bg-amber-50'
                        }
                        variant="secondary"
                      >
                        {status}
                      </Badge>
                    </TableCell>
                    <TableCell>{reviewer}</TableCell>
                    <TableCell>
                      <Button size="icon-sm" variant="ghost">
                        <Ellipsis className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5 text-sm text-muted-foreground">
              <p>0 of 68 row(s) selected.</p>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <span>Rows per page</span>
                  <Button className="rounded-2xl" size="sm" variant="outline">
                    10
                    <ChevronDown className="size-4" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <span>Page 1 of 7</span>
                  <div className="flex items-center gap-1">
                    <Button size="icon-sm" variant="outline">
                      <ChevronsLeft className="size-4" />
                    </Button>
                    <Button size="icon-sm" variant="outline">
                      <ChevronLeft className="size-4" />
                    </Button>
                    <Button size="icon-sm" variant="outline">
                      <ChevronRight className="size-4" />
                    </Button>
                    <Button size="icon-sm" variant="outline">
                      <ChevronsRight className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
