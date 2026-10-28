import Link from 'next/link';
import type { ParcelStatus } from '@swiftdrop/contracts';
import { Alert, EmptyState, PageHeader } from '@/components/ui';
import { TrackForm, TrackingView } from '@/features/tracking';
import { errorCode, errorMessage } from '@/lib/api/errors';
import { serverApi } from '@/lib/api/server';

export default async function TrackPage({
  params,
}: {
  params: Promise<{ trackingNumber: string }>;
}) {
  const { trackingNumber } = await params;
  const api = await serverApi();

  const { data: parcel, error } = await api.GET('/api/v1/tracking/{trackingNumber}', {
    params: { path: { trackingNumber } },
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <Link
        href="/"
        className="inline-flex items-center text-sm font-medium text-brand hover:underline"
      >
        ← Back to SwiftDrop
      </Link>

      <div className="mt-6">
        <PageHeader
          title={`Tracking ${trackingNumber}`}
          description="Live parcel delivery status and milestone tracking"
        />

        {error || !parcel ? (
          <div className="mt-8 space-y-6">
            {errorCode(error) === 'NOT_FOUND' ? (
              <EmptyState
                title="Parcel Not Found"
                description={`We couldn't locate any parcel with tracking number "${trackingNumber}". Please verify the number and try again.`}
              />
            ) : (
              <Alert tone="error">
                {errorMessage(error, 'Tracking is unavailable right now. Please try again.')}
              </Alert>
            )}
            <div className="rounded-lg border border-line bg-surface p-6">
              <h3 className="mb-3 text-sm font-medium text-ink">Track Another Parcel</h3>
              <TrackForm />
            </div>
          </div>
        ) : (
          <div className="mt-6">
            <TrackingView
              trackingNumber={parcel.trackingNumber}
              initialStatus={parcel.status as ParcelStatus}
              initialHistory={parcel.history.map((h) => ({
                status: h.status as ParcelStatus,
                at: new Date(h.at).toISOString(),
                reason: (h.reason as string | null) ?? null,
              }))}
              initialUpdatedAt={new Date(parcel.updatedAt).toISOString()}
              originCity={parcel.originCity}
              destinationCity={parcel.destinationCity}
            />
          </div>
        )}
      </div>
    </main>
  );
}
