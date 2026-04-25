# Supplier Scorecard Reporting

## Overview

The Supplier Scorecard service provides comprehensive vendor performance metrics based on purchase order on-time delivery and quality (NCR) data. This enables data-driven supplier management and procurement decisions.

## Metrics Tracked

### Delivery Performance
- **On-Time Delivery Rate**: Percentage of receipts delivered on or before `expected_date`
- **Total Receipts**: Count of purchase order receipts
- **On-Time Receipts**: Receipts where `DATE(received_at) <= expected_date`
- **Late Receipts**: Receipts where `DATE(received_at) > expected_date`
- **Average Days Late**: Mean number of days late for late deliveries

### Quality Performance
- **Total QC Events**: All quality control inspections performed
- **Accepted Quantity**: Total quantity accepted through QC
- **Rejected Quantity**: Total quantity rejected through QC
- **Held Quantity**: Total quantity held in QC for further review
- **Quality Rate**: `(accepted / (accepted + rejected)) × 100`

### Non-Conformance Reports (NCR)
- **Total NCRs**: All NCRs generated from quality rejections
- **Open NCRs**: NCRs awaiting disposition
- **Closed NCRs**: NCRs with completed disposition
- **Disposition Breakdown**:
  - Return to Vendor
  - Scrap
  - Rework
  - Use As-Is

## API Endpoints

### 1. GET /supplier-scorecards
Query supplier scorecards with optional filters.

**Query Parameters:**
- `vendorId` (optional): Filter by specific vendor UUID
- `startDate` (optional): Filter POs created on/after date (YYYY-MM-DD)
- `endDate` (optional): Filter POs created on/before date (YYYY-MM-DD)
- `limit` (optional): Max results (default 100, max 1000)
- `offset` (optional): Pagination offset

**Response:**
```json
{
  "data": [
    {
      "vendorId": "uuid",
      "vendorCode": "ACME-001",
      "vendorName": "ACME Supplies",
      "totalPurchaseOrders": 45,
      "totalPoLines": 158,
      "totalReceipts": 42,
      "onTimeReceipts": 38,
      "lateReceipts": 4,
      "onTimeDeliveryRate": 90.48,
      "averageDaysLate": 3.5,
      "totalQcEvents": 125,
      "acceptedQuantity": 4850.5,
      "rejectedQuantity": 125.0,
      "heldQuantity": 50.0,
      "totalNcrs": 8,
      "openNcrs": 2,
      "closedNcrs": 6,
      "qualityRate": 97.49,
      "returnToVendorCount": 3,
      "scrapCount": 2,
      "reworkCount": 1,
      "useAsIsCount": 2
    }
  ]
}
```

**Example:**
```bash
GET /supplier-scorecards?startDate=2025-01-01&endDate=2025-12-31&limit=50
```

---

### 2. GET /supplier-scorecards/:vendorId
Get detailed scorecard for a specific supplier.

**Path Parameters:**
- `vendorId` (required): Vendor UUID

**Query Parameters:**
- `startDate` (optional): Filter POs created on/after date (YYYY-MM-DD)
- `endDate` (optional): Filter POs created on/before date (YYYY-MM-DD)

**Response:** Same structure as above, single scorecard object

**Example:**
```bash
GET /supplier-scorecards/123e4567-e89b-12d3-a456-426614174000?startDate=2025-01-01
```

---

### 3. GET /supplier-scorecards/rankings/delivery
Get top-performing suppliers ranked by on-time delivery rate.

**Query Parameters:**
- `limit` (optional): Max results (default 10, max 100)

**Response:** Array of scorecards sorted by `onTimeDeliveryRate` descending

**Filtering:**
- Only includes suppliers with ≥3 receipts for statistical significance

**Example:**
```bash
GET /supplier-scorecards/rankings/delivery?limit=5
```

---

### 4. GET /supplier-scorecards/rankings/quality
Get top-performing suppliers ranked by quality acceptance rate.

**Query Parameters:**
- `limit` (optional): Max results (default 10, max 100)

**Response:** Array of scorecards sorted by `qualityRate` descending

**Filtering:**
- Only includes suppliers with ≥5 QC events for statistical significance

**Example:**
```bash
GET /supplier-scorecards/rankings/quality?limit=5
```

---

### 5. GET /supplier-scorecards/issues/quality
Identify suppliers with quality issues (high rejection rates or open NCRs).

**Query Parameters:**
- `minRejectionRate` (optional): Minimum rejection rate threshold (default 5%)

**Response:** Array of scorecards for suppliers with quality concerns, sorted by rejection rate descending

**Filtering:**
- Suppliers with rejection rate ≥ `minRejectionRate` OR
- Suppliers with open NCRs

**Example:**
```bash
GET /supplier-scorecards/issues/quality?minRejectionRate=10
```

---

## Database Relationships

### Data Sources

**Delivery Metrics:**
```sql
purchase_orders (po.expected_date)
  ↓
purchase_order_receipts (por.received_at)
  
Calculation: DATE(received_at) <= expected_date
```

**Quality Metrics:**
```sql
purchase_orders
  ↓
purchase_order_lines
  ↓
purchase_order_receipt_lines
  ↓
qc_events (event_type: accept/reject/hold, quantity)
  ↓
ncrs (status, disposition_type)
```

### Key Calculations

**On-Time Delivery Rate:**
```
(on_time_receipts / total_receipts) × 100
```

**Quality Rate:**
```
(accepted_quantity / (accepted_quantity + rejected_quantity)) × 100
```

**Average Days Late:**
```
AVG(DATE(received_at) - expected_date) 
WHERE received_at > expected_date
```

## Use Cases

### 1. Supplier Performance Review
```bash
# Get quarterly performance for a specific vendor
GET /supplier-scorecards/vendor-uuid?startDate=2025-01-01&endDate=2025-03-31
```

**Decision Support:**
- On-time delivery < 80%? → Escalate with vendor
- Quality rate < 95%? → Require corrective action plan
- Multiple open NCRs? → Consider alternative sources

### 2. Vendor Selection for New Projects
```bash
# Identify best suppliers by delivery and quality
GET /supplier-scorecards/rankings/delivery?limit=10
GET /supplier-scorecards/rankings/quality?limit=10
```

**Decision Support:**
- Cross-reference top performers in both metrics
- Prioritize suppliers with proven track record

### 3. Supplier Development Programs
```bash
# Find suppliers needing improvement
GET /supplier-scorecards/issues/quality?minRejectionRate=10
```

**Decision Support:**
- Identify root causes from NCR disposition types
- Schedule quality improvement meetings
- Consider supplier audits

### 4. Strategic Sourcing Decisions
```bash
# Annual review of all suppliers
GET /supplier-scorecards?startDate=2025-01-01&endDate=2025-12-31&limit=1000
```

**Decision Support:**
- Allocate more business to top performers
- Phase out consistently poor performers
- Balance risk across multiple suppliers

## Performance Considerations

### Indexing
The following indexes optimize scorecard queries:

- `purchase_orders`: `(vendor_id, status)`, `created_at`
- `purchase_order_receipts`: `purchase_order_id`, `received_at`
- `qc_events`: `purchase_order_receipt_line_id`, `event_type`
- `ncrs`: `qc_event_id`, `status`

### Query Optimization
The service uses CTEs (Common Table Expressions) to:
1. Minimize table scans
2. Calculate metrics in parallel
3. Join aggregated results efficiently

### Caching Strategy (Future)
For high-traffic scenarios, consider:
- Materialized view refreshed daily
- Redis cache for frequently accessed vendors
- Pre-calculated quarterly snapshots

## Integration Examples

### Procurement Workflow
```javascript
// Before issuing PO, check supplier performance
const scorecard = await getSupplierScorecardDetail(tenantId, vendorId);

if (scorecard.onTimeDeliveryRate < 85) {
  // Warn purchasing team
  console.warn(`Vendor has ${scorecard.onTimeDeliveryRate}% on-time delivery`);
  // Consider requiring earlier expected_date
}

if (scorecard.openNcrs > 2) {
  // Require quality manager approval
  throw new Error('Vendor has open quality issues - requires approval');
}
```

### Automated Alerts
```javascript
// Daily job to identify quality issues
const problematicSuppliers = await getSuppliersWithQualityIssues(tenantId, 5);

for (const supplier of problematicSuppliers) {
  await sendAlert({
    to: 'quality@company.com',
    subject: `Quality Issue: ${supplier.vendorName}`,
    body: `
      Vendor: ${supplier.vendorName}
      Quality Rate: ${supplier.qualityRate}%
      Open NCRs: ${supplier.openNcrs}
      Recent Rejections: ${supplier.rejectedQuantity}
    `
  });
}
```

### Dashboard Metrics
```javascript
// Populate executive dashboard
const topDelivery = await getTopSuppliersByDelivery(tenantId, 5);
const topQuality = await getTopSuppliersByQuality(tenantId, 5);
const issues = await getSuppliersWithQualityIssues(tenantId);

return {
  bestPerformers: {
    delivery: topDelivery,
    quality: topQuality
  },
  actionRequired: issues,
  overallMetrics: {
    avgOnTimeRate: calculateAverage(topDelivery, 'onTimeDeliveryRate'),
    avgQualityRate: calculateAverage(topQuality, 'qualityRate')
  }
};
```

## Future Enhancements

### Planned Features
1. **Cost Variance Tracking**: Compare PO unit_price vs receipt unit_cost
2. **Lead Time Analysis**: Track actual vs expected lead times
3. **Defect Categorization**: Break down rejections by reason code
4. **Trend Analysis**: Month-over-month performance trends
5. **Supplier Risk Score**: Composite score based on multiple factors
6. **Automated Vendor Rating**: A/B/C classification system

### Data Export
Future API endpoints for:
- PDF scorecard generation
- CSV export for spreadsheet analysis
- Scheduled email reports

## Related Services

- **Vendors Service**: CRUD operations for vendor master data
- **Purchase Orders Service**: PO creation and management
- **Receipts Service**: PO receipt processing
- **QC Service**: Quality control event recording
- **NCR Service**: Non-conformance report management

## Troubleshooting

### No Data Returned
**Issue**: Scorecard returns empty or zero metrics
**Causes:**
- No receipts with `expected_date` set (on-time metrics require this)
- No QC events recorded (quality metrics require QC inspection)
- Date filters too restrictive

**Solution:**
```bash
# Check if vendor has any POs
GET /purchase-orders?vendorId=uuid

# Check if receipts have expected dates
SELECT COUNT(*) FROM purchase_orders WHERE vendor_id = 'uuid' AND expected_date IS NOT NULL;
```

### Performance Issues
**Issue**: Slow query response
**Causes:**
- Large date range without vendor filter
- Missing database indexes

**Solution:**
- Add vendor filter when possible
- Use date range filters to limit data
- Consider pagination for large result sets

### Incorrect Calculations
**Issue**: Metrics don't match manual counts
**Causes:**
- Tenant isolation not working
- Voided/canceled receipts included

**Debugging:**
```sql
-- Verify receipt counts
SELECT COUNT(*) FROM purchase_order_receipts por
JOIN purchase_orders po ON po.id = por.purchase_order_id
WHERE po.vendor_id = 'uuid' AND por.tenant_id = 'tenant-uuid';

-- Check QC event totals
SELECT event_type, SUM(quantity) 
FROM qc_events qe
JOIN purchase_order_receipt_lines prl ON prl.id = qe.purchase_order_receipt_line_id
WHERE qe.tenant_id = 'tenant-uuid'
GROUP BY event_type;
```
