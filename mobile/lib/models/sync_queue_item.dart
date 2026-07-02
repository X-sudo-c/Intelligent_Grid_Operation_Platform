/// One row in the field sync queue (captures, spans, bills, work-order updates).
class SyncQueueItem {
  const SyncQueueItem({
    required this.kind,
    required this.title,
    required this.status,
    this.detail,
    this.createdAt,
  });

  final String kind;
  final String title;
  final String status;
  final String? detail;
  final String? createdAt;

  bool get isConflicted => status == 'CONFLICTED';
  bool get isPending => status == 'PENDING' || status == 'QUEUED';
}
