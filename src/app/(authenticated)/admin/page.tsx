import {
  ChevronDown,
  ChevronRight,
  Plus,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';

import {
  SimilarityFailRateTrendChart,
  type SimilarityFailRateTrendPoint,
} from '~/components/admin/SimilarityFailRateTrendChart';
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
import { formatCompactInt } from '~/lib/tests/format';
import {
  getGlobalSimilarityFailRateTrend,
  getGlobalTestCaseMetrics,
} from '~/lib/tests/repository';

export const metadata = {
  title: 'Admin Dashboard | Betco BEX',
  description:
    'Overview dashboard for Betco BEX admin operations and shortcuts.',
};

type MetricCardData = {
  title: string;
  value: string;
  delta?: string;
  trend?: 'up' | 'down';
  summary: string;
  detail: string;
};

function buildMetrics(
  input: Awaited<ReturnType<typeof getGlobalTestCaseMetrics>>,
): MetricCardData[] {
  return [
    {
      title: 'Avg Similarity',
      value:
        input.avgSimilarity === null
          ? 'n/a'
          : `${(input.avgSimilarity * 100).toFixed(1)}%`,
      summary:
        input.avgSimilarity === null
          ? 'No similarity-bearing responses yet'
          : 'Average source similarity across all completed test cases',
      detail: `Based on ${formatCompactInt(input.similaritySampleSize)} test case(s) with similarity data`,
    },
    {
      title: 'Avg Elapsed Runtime',
      value: `${(input.avgElapsedMs / 1000).toFixed(2)}s`,
      summary: 'Mean elapsed runtime across all completed test cases',
      detail: `Based on ${formatCompactInt(input.totalCases)} completed test case(s)`,
    },
    {
      title: 'Avg Pass Rate',
      value: `${(input.passRate * 100).toFixed(1)}%`,
      summary: 'Passed test cases divided by all completed test cases',
      detail: `${formatCompactInt(input.passedCases)} passed / ${formatCompactInt(input.totalCases)} total`,
    },
    {
      title: 'Avg Fail Rate',
      value: `${(input.failRate * 100).toFixed(1)}%`,
      summary: 'Failed test cases divided by all completed test cases',
      detail: `${formatCompactInt(input.failedCases)} failed / ${formatCompactInt(input.totalCases)} total`,
    },
  ];
}

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
  [
    'Integration with existing systems',
    'Narrative',
    'In Process',
    'Jamik Tashpulatov',
  ],
  ['Innovation and Advantages', 'Narrative', 'Done', 'Assign reviewer'],
  [
    "Overview of EMR's Innovative Solutions",
    'Technical content',
    'Done',
    'Assign reviewer',
  ],
  [
    'Advanced Algorithms and Machine Learning',
    'Narrative',
    'Done',
    'Assign reviewer',
  ],
];

function MetricCard({
  detail,
  delta,
  summary,
  title,
  trend,
  value,
}: MetricCardData) {
  const showTrend = trend && delta;
  const isUp = trend === 'up';
  const TrendIcon = isUp ? TrendingUp : TrendingDown;

  return (
    <Card className="gap-4 rounded-3xl border border-border/60 shadow-none">
      <CardHeader className="px-5 pb-0">
        <CardDescription>{title}</CardDescription>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-3xl font-semibold">{value}</CardTitle>
          {showTrend ? (
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
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-1 px-5 pt-0 text-sm">
        <p className="font-medium text-foreground">{summary}</p>
        <p className="text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

export default async function AdminDashboardPage() {
  await connection();
  const [globalMetrics, similarityFailTrendRaw] = await Promise.all([
    getGlobalTestCaseMetrics(),
    getGlobalSimilarityFailRateTrend({ maxRuns: 30 }),
  ]);
  const similarityFailTrend: SimilarityFailRateTrendPoint[] =
    similarityFailTrendRaw;
  const metrics = buildMetrics(globalMetrics);

  return (
    <main className="min-w-0 p-4 sm:p-6">
      <div className="rounded-[2rem] border border-border/60 bg-background shadow-sm">
        <div className="flex items-center justify-between gap-4 px-6 py-5 sm:px-8">
          <div>
            <p className="text-sm text-muted-foreground">Dashboard</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">
              Documents
            </h1>
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
                  <CardTitle className="text-lg font-semibold">
                    Similarity and fail-rate trend
                  </CardTitle>
                  <CardDescription>
                    Per-run averages over the latest 30 test runs
                  </CardDescription>
                </div>
                <Button className="rounded-2xl" size="sm" variant="outline">
                  Last 30 runs
                  <ChevronDown className="size-4" />
                </Button>
              </CardHeader>
              <CardContent className="px-5 pt-0">
                <SimilarityFailRateTrendChart points={similarityFailTrend} />
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
                      ['Tools home', '/admin/tools'],
                      ['Legacy product browser', '/admin/products/legacy'],
                      ['RAG search', '/admin/products/rag'],
                      ['SDS ingestion dashboard', '/admin/sds'],
                      ['Efficacy ingestion dashboard', '/admin/efficacy'],
                      ['RAG generation', '/admin/products/rag/generate'],
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
        </div>
      </div>
    </main>
  );
}
