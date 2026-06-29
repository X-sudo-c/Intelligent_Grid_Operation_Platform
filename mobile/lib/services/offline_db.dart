import 'dart:convert';

import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

import '../models/asset_node.dart';

/// Local offline queue and map node cache.
class OfflineDb {
  OfflineDb._();
  static Database? _db;

  static Future<Database> instance() async {
    if (_db != null) return _db!;
    final dbPath = await getDatabasesPath();
    _db = await openDatabase(
      join(dbPath, 'giop_field.db'),
      version: 10,
        onCreate: (db, version) async {
        await _createV1Tables(db);
        await _createCacheTable(db);
        await _createV3Tables(db);
        await _createV5Tables(db);
        await _createV6Tables(db);
        await _createV9Columns(db);
        await _createV10Tables(db);
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await _createCacheTable(db);
        }
        if (oldVersion < 3) {
          await _createV3Tables(db);
        }
        if (oldVersion < 4) {
          await _createV4Columns(db);
        }
        if (oldVersion < 5) {
          await _createV5Tables(db);
        }
        if (oldVersion < 6) {
          await _createV6Tables(db);
        }
        if (oldVersion < 7) {
          await _createV7Columns(db);
        }
        if (oldVersion < 8) {
          await _createV8Columns(db);
        }
        if (oldVersion < 9) {
          await _createV9Columns(db);
        }
        if (oldVersion < 10) {
          await _createV10Columns(db);
        }
      },
    );
    return _db!;
  }

  static Future<void> _createV1Tables(Database db) async {
    await db.execute('''
      CREATE TABLE field_captured_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mrid TEXT,
        name TEXT NOT NULL,
        longitude REAL NOT NULL,
        latitude REAL NOT NULL,
        asset_kind TEXT NOT NULL DEFAULT 'pole_lv',
        validation TEXT DEFAULT 'PENDING_FIELD',
        is_dirty INTEGER NOT NULL DEFAULT 1,
        captured_at TEXT NOT NULL DEFAULT (datetime('now')),
        offline_session_started_at TEXT,
        cached_server_updated_at TEXT,
        sync_status TEXT NOT NULL DEFAULT 'PENDING'
      )
    ''');
    await db.execute('''
      CREATE TABLE local_spot_bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_mrid TEXT NOT NULL,
        meter_mrid TEXT,
        previous_reading REAL NOT NULL,
        current_reading REAL NOT NULL,
        photo_path TEXT,
        is_dirty INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
    await db.execute(
      'CREATE INDEX idx_field_dirty ON field_captured_assets (is_dirty)',
    );
  }

  static Future<void> _createCacheTable(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS cached_map_nodes (
        mrid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        validation TEXT NOT NULL,
        tier TEXT NOT NULL,
        layer TEXT NOT NULL,
        boundary_feeder_id TEXT,
        operating_utility TEXT,
        substation_name TEXT,
        asset_kind TEXT,
        wire_degree INTEGER NOT NULL DEFAULT 0,
        cached_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
  }

  static Future<void> _createV3Tables(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_customer_profiles (
        account_mrid TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        account_number TEXT NOT NULL,
        balance_ghs REAL NOT NULL DEFAULT 0
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS offline_tiles_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        z INTEGER NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        layer_id TEXT NOT NULL,
        pbf_blob BLOB,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (z, x, y, layer_id)
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_spot_bills_dirty ON local_spot_bills (is_dirty)',
    );
  }

  static Future<void> _createV4Columns(Database db) async {
    for (final sql in [
      "ALTER TABLE field_captured_assets ADD COLUMN offline_session_started_at TEXT",
      "ALTER TABLE field_captured_assets ADD COLUMN cached_server_updated_at TEXT",
      "ALTER TABLE field_captured_assets ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'PENDING'",
    ]) {
      try {
        await db.execute(sql);
      } catch (_) {
        // column may already exist
      }
    }
  }

  static Future<void> _createV5Tables(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_work_orders (
        id TEXT PRIMARY KEY,
        reference TEXT NOT NULL,
        work_type TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 3,
        status TEXT NOT NULL,
        assigned_crew TEXT,
        assigned_user TEXT,
        summary TEXT NOT NULL,
        notes TEXT,
        is_dirty INTEGER NOT NULL DEFAULT 0,
        sync_status TEXT NOT NULL DEFAULT 'SYNCED',
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS work_order_status_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_order_id TEXT NOT NULL,
        new_status TEXT NOT NULL,
        notes TEXT,
        is_dirty INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_wo_status_dirty ON work_order_status_updates (is_dirty)',
    );
  }

  static Future<void> _createV7Columns(Database db) async {
    try {
      await db.execute(
        "ALTER TABLE cached_map_nodes ADD COLUMN asset_kind TEXT",
      );
    } catch (_) {
      // column may already exist
    }
  }

  static Future<void> _createV8Columns(Database db) async {
    try {
      await db.execute(
        'ALTER TABLE cached_map_nodes ADD COLUMN wire_degree INTEGER NOT NULL DEFAULT 0',
      );
    } catch (_) {
      // column may already exist
    }
  }

  static Future<void> _createV9Columns(Database db) async {
    try {
      await db.execute(
        "ALTER TABLE field_captured_assets ADD COLUMN asset_kind TEXT NOT NULL DEFAULT 'pole_lv'",
      );
    } catch (_) {
      // column may already exist
    }
  }

  static Future<void> _createV10Columns(Database db) async {
    for (final sql in [
      "ALTER TABLE field_captured_assets ADD COLUMN work_order_id TEXT",
      "ALTER TABLE field_captured_assets ADD COLUMN photo_path TEXT",
    ]) {
      try {
        await db.execute(sql);
      } catch (_) {}
    }
  }

  static Future<void> _createV10Tables(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS field_spans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        boundary_feeder_id TEXT,
        work_order_id TEXT,
        name TEXT,
        is_dirty INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
  }

  static Future<void> _createV6Tables(Database db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS cached_node_topology (
        node_mrid TEXT PRIMARY KEY,
        topology_json TEXT NOT NULL,
        cached_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    ''');
    await db.execute(
      'CREATE INDEX IF NOT EXISTS idx_cached_node_topology_at ON cached_node_topology (cached_at DESC)',
    );
  }

  static Future<int> queueFieldCapture({
    required String name,
    required double longitude,
    required double latitude,
    String? mrid,
    String assetKind = 'pole_lv',
    String? workOrderId,
    String? photoPath,
  }) async {
    final db = await instance();
    final sessionAt = DateTime.now().toUtc().toIso8601String();
    return db.insert('field_captured_assets', {
      'name': name,
      'longitude': longitude,
      'latitude': latitude,
      'mrid': mrid,
      'asset_kind': assetKind,
      'work_order_id': workOrderId,
      'photo_path': photoPath,
      'is_dirty': 1,
      'offline_session_started_at': sessionAt,
      'sync_status': 'PENDING',
    });
  }

  static Future<int> queueFieldSpan({
    required String sourceNodeId,
    required String targetNodeId,
    String? boundaryFeederId,
    String? workOrderId,
    String? name,
  }) async {
    final db = await instance();
    return db.insert('field_spans', {
      'source_node_id': sourceNodeId,
      'target_node_id': targetNodeId,
      'boundary_feeder_id': boundaryFeederId,
      'work_order_id': workOrderId,
      'name': name,
      'is_dirty': 1,
    });
  }

  static Future<List<Map<String, dynamic>>> pendingSpans() async {
    final db = await instance();
    return db.query(
      'field_spans',
      where: 'is_dirty = ?',
      whereArgs: [1],
      orderBy: 'id ASC',
    );
  }

  static Future<void> markSpanSynced(int id) async {
    final db = await instance();
    await db.update(
      'field_spans',
      {'is_dirty': 0},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  static Future<List<Map<String, dynamic>>> pendingCaptures() async {
    final db = await instance();
    return db.query(
      'field_captured_assets',
      where: 'is_dirty = ?',
      whereArgs: [1],
      orderBy: 'id ASC',
    );
  }

  static Future<void> markCaptureConflicted(int id) async {
    final db = await instance();
    await db.update(
      'field_captured_assets',
      {'sync_status': 'CONFLICTED', 'is_dirty': 1},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  static Future<void> markCaptureSynced(int id, String mrid) async {
    final db = await instance();
    await db.update(
      'field_captured_assets',
      {'is_dirty': 0, 'mrid': mrid, 'sync_status': 'SYNCED'},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  static Future<Set<String>> knownLocalMrids() async {
    final db = await instance();
    final rows = await db.query(
      'field_captured_assets',
      columns: ['mrid'],
    );
    return rows
        .map((r) => r['mrid'] as String?)
        .whereType<String>()
        .toSet();
  }

  static Future<int> queueSpotBill({
    required String accountMrid,
    required double previousReading,
    required double currentReading,
    String? meterMrid,
    String? photoPath,
  }) async {
    final db = await instance();
    return db.insert('local_spot_bills', {
      'account_mrid': accountMrid,
      'meter_mrid': meterMrid,
      'previous_reading': previousReading,
      'current_reading': currentReading,
      'photo_path': photoPath,
      'is_dirty': 1,
    });
  }

  static Future<List<Map<String, dynamic>>> pendingSpotBills() async {
    final db = await instance();
    return db.query(
      'local_spot_bills',
      where: 'is_dirty = ?',
      whereArgs: [1],
      orderBy: 'id ASC',
    );
  }

  static Future<void> markSpotBillSynced(int id) async {
    final db = await instance();
    await db.update(
      'local_spot_bills',
      {'is_dirty': 0},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  static Future<void> upsertCustomerProfile({
    required String accountMrid,
    required String customerName,
    required String accountNumber,
    double balanceGhs = 0,
  }) async {
    final db = await instance();
    await db.insert(
      'local_customer_profiles',
      {
        'account_mrid': accountMrid,
        'customer_name': customerName,
        'account_number': accountNumber,
        'balance_ghs': balanceGhs,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  static Future<void> cacheTile({
    required int z,
    required int x,
    required int y,
    required String layerId,
    required List<int> pbfBytes,
  }) async {
    final db = await instance();
    await db.insert(
      'offline_tiles_cache',
      {
        'z': z,
        'x': x,
        'y': y,
        'layer_id': layerId,
        'pbf_blob': pbfBytes,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
    final count = Sqflite.firstIntValue(
          await db.rawQuery('SELECT COUNT(*) FROM offline_tiles_cache'),
        ) ??
        0;
    if (count > 120) {
      await db.rawDelete(
        'DELETE FROM offline_tiles_cache WHERE id IN (SELECT id FROM offline_tiles_cache ORDER BY fetched_at ASC LIMIT 20)',
      );
    }
  }

  static Future<List<int>?> loadCachedTile({
    required int z,
    required int x,
    required int y,
    required String layerId,
  }) async {
    final db = await instance();
    final rows = await db.query(
      'offline_tiles_cache',
      columns: ['pbf_blob'],
      where: 'z = ? AND x = ? AND y = ? AND layer_id = ?',
      whereArgs: [z, x, y, layerId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final blob = rows.first['pbf_blob'];
    if (blob is List<int>) return blob;
    return null;
  }

  static Future<void> cacheMapNodes(List<AssetNode> nodes) async {
    final db = await instance();
    final batch = db.batch();
    batch.delete('cached_map_nodes');
    for (final node in nodes) {
      if (!node.hasCoordinates) continue;
      batch.insert('cached_map_nodes', node.toCacheRow());
    }
    await batch.commit(noResult: true);
  }

  static Future<List<AssetNode>> loadCachedMapNodes() async {
    final db = await instance();
    final rows = await db.query('cached_map_nodes', orderBy: 'name ASC');
    return rows.map(AssetNode.fromCacheRow).toList();
  }

  static Future<void> cacheNodeTopologyBatch(
    Map<String, dynamic> connectionsByMrid, {
    bool replaceAll = false,
  }) async {
    if (connectionsByMrid.isEmpty) return;
    final db = await instance();
    final batch = db.batch();
    if (replaceAll) {
      batch.delete('cached_node_topology');
    }
    for (final entry in connectionsByMrid.entries) {
      final topo = entry.value;
      if (topo is! Map) continue;
      batch.insert(
        'cached_node_topology',
        {
          'node_mrid': entry.key,
          'topology_json': jsonEncode(topo),
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  static Future<void> upsertNodeTopology(
    String mrid,
    Map<String, dynamic> topology,
  ) async {
    final db = await instance();
    await db.insert(
      'cached_node_topology',
      {
        'node_mrid': mrid,
        'topology_json': jsonEncode(topology),
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  static Future<Map<String, dynamic>?> getCachedNodeTopology(String mrid) async {
    final db = await instance();
    final rows = await db.query(
      'cached_node_topology',
      where: 'node_mrid = ?',
      whereArgs: [mrid],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final raw = rows.first['topology_json'];
    if (raw is! String) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {
      return null;
    }
    return null;
  }

  static Future<int> cachedTopologyCount() async {
    final db = await instance();
    return Sqflite.firstIntValue(
          await db.rawQuery('SELECT COUNT(*) FROM cached_node_topology'),
        ) ??
        0;
  }

  static double estimateTariffGhs(double consumption) {
    if (consumption <= 30) return consumption * 0.98;
    if (consumption <= 300) {
      return 30 * 0.98 + (consumption - 30) * 1.25;
    }
    return 30 * 0.98 + 270 * 1.25 + (consumption - 300) * 1.75;
  }

  static Future<void> upsertWorkOrders(List<Map<String, dynamic>> orders) async {
    final db = await instance();
    final batch = db.batch();
    for (final wo in orders) {
      final id = wo['id'] as String?;
      if (id == null) continue;
      batch.insert(
        'local_work_orders',
        {
          'id': id,
          'reference': wo['reference'] ?? '',
          'work_type': wo['work_type'] ?? 'OTHER',
          'priority': wo['priority'] ?? 3,
          'status': wo['status'] ?? 'DISPATCHED',
          'assigned_crew': wo['assigned_crew'],
          'assigned_user': wo['assigned_user'],
          'summary': wo['summary'] ?? '',
          'notes': wo['notes'],
          'is_dirty': 0,
          'sync_status': 'SYNCED',
        },
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    }
    await batch.commit(noResult: true);
  }

  static Future<List<Map<String, dynamic>>> listWorkOrders() async {
    final db = await instance();
    return db.query('local_work_orders', orderBy: 'fetched_at DESC');
  }

  static Future<void> updateLocalWorkOrderStatus(String id, String status) async {
    final db = await instance();
    await db.update(
      'local_work_orders',
      {'status': status, 'is_dirty': 1, 'sync_status': 'PENDING'},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  static Future<int> queueWorkOrderStatusUpdate({
    required String workOrderId,
    required String newStatus,
    String? notes,
  }) async {
    final db = await instance();
    await updateLocalWorkOrderStatus(workOrderId, newStatus);
    return db.insert('work_order_status_updates', {
      'work_order_id': workOrderId,
      'new_status': newStatus,
      'notes': notes,
      'is_dirty': 1,
    });
  }

  static Future<List<Map<String, dynamic>>> pendingWorkOrderStatusUpdates() async {
    final db = await instance();
    return db.query(
      'work_order_status_updates',
      where: 'is_dirty = ?',
      whereArgs: [1],
      orderBy: 'id ASC',
    );
  }

  static Future<void> markWorkOrderStatusUpdateSynced(int queueId, String workOrderId) async {
    final db = await instance();
    await db.update(
      'work_order_status_updates',
      {'is_dirty': 0},
      where: 'id = ?',
      whereArgs: [queueId],
    );
    await db.update(
      'local_work_orders',
      {'is_dirty': 0, 'sync_status': 'SYNCED'},
      where: 'id = ?',
      whereArgs: [workOrderId],
    );
  }
}
