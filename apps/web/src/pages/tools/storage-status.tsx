import StorageBackupStatus from '@web/components/StorageBackupStatus';

/** Only the delivered storage disclosure is connected on this main slice. */
export default function StorageStatus() {
  return (
    <section className="h-full overflow-auto p-4">
      <h1 className="text-lg font-semibold">存储与备份</h1>
      <StorageBackupStatus />
    </section>
  );
}
