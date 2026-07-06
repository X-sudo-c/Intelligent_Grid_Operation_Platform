"""Unit tests for CIM RDF/XML serializer."""

from cim_rdf import build_cim_rdf_xml, validate_rdf_fragment

SAMPLE = {
    "@profile": "GIOP-Distribution-MVP-1.1",
    "exported_at": "2026-06-28T12:00:00Z",
    "ConnectivityNode": [
        {
            "mrid": "11111111-1111-1111-1111-111111111111",
            "name": "Node-A",
            "lifecycle_state": "IN_SERVICE",
            "boundary_feeder_id": "FEEDER-1",
            "location": {"type": "Point", "coordinates": [-0.2, 5.6]},
        }
    ],
    "ACLineSegment": [
        {
            "mrid": "22222222-2222-2222-2222-222222222222",
            "name": "Line-1",
            "source_node_mrid": "11111111-1111-1111-1111-111111111111",
            "target_node_mrid": "33333333-3333-3333-3333-333333333333",
            "nominal_voltage": "MV_11KV",
            "phases": "ABC",
            "direction_downstream": True,
        }
    ],
    "UsagePoint": [
        {
            "mrid": "44444444-4444-4444-4444-444444444444",
            "name": "UP-1",
            "account_mrid": "55555555-5555-5555-5555-555555555555",
            "location": {"type": "Point", "coordinates": [-0.21, 5.61]},
        }
    ],
    "Meter": [
        {
            "mrid": "66666666-6666-6666-6666-666666666666",
            "name": "Meter-1",
            "serial_number": "SN-001",
            "manufacturer": "ACME",
            "installed_at": "2024-01-15T00:00:00",
        }
    ],
    "PowerTransformer": [
        {
            "mrid": "77777777-7777-7777-7777-777777777777",
            "name": "DT-1",
            "connectivity_node_mrid": "11111111-1111-1111-1111-111111111111",
            "transformer_kind": "distribution",
            "nominal_voltage": "MV_11KV",
            "phases": "ABC",
            "rated_power_kva": 500.0,
            "vector_group": "Dyn11",
            "location": {"type": "Point", "coordinates": [-0.2, 5.6]},
        }
    ],
    "Asset": [
        {
            "mrid": "88888888-8888-8888-8888-888888888888",
            "name": "Asset-DT-1",
            "equipment_mrid": "77777777-7777-7777-7777-777777777777",
            "asset_kind": "distribution_transformer",
        }
    ],
    "AssetInfo": [
        {
            "@type": "PowerTransformerInfo",
            "mrid": "99999999-9999-9999-9999-999999999999",
            "name": "DT-1 Info",
            "asset_mrid": "88888888-8888-8888-8888-888888888888",
            "manufacturer": "ABB",
            "model_number": "DT-500",
            "serial_number": "SN-DT-1",
            "rated_power_kva": 500.0,
            "year_of_manufacture": 2018,
        }
    ],
    "extensions": {
        "GhanaGridAsset": [
            {
                "mrid": "11111111-1111-1111-1111-111111111111",
                "operating_utility": "ECG_SOUTHERN",
                "substation_name": "Sub-A",
            }
        ]
    },
    "counts": {"total_features": 5},
}


def test_build_cim_rdf_xml_structure():
    xml = build_cim_rdf_xml(SAMPLE)
    validate_rdf_fragment(xml)
    assert "http://www.w3.org/1999/02/22-rdf-syntax-ns#" in xml
    assert "http://iec.ch/TC57/CIM100#" in xml
    assert "ConnectivityNode" in xml
    assert "ACLineSegment" in xml
    assert "Terminal" in xml
    assert "IdentifiedObject.mRID" in xml
    assert "11111111-1111-1111-1111-111111111111" in xml
    assert "gio:ConnectivityNode.boundaryFeederId" in xml or "boundaryFeederId" in xml
    assert "BaseVoltage" in xml
    assert "PowerTransformer" in xml
    assert "Asset" in xml
    assert "PowerTransformerInfo" in xml
    assert "FullModel" in xml
