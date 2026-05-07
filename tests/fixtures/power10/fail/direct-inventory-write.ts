export const directWriteSql = `
  INSERT INTO inventory_balance (item_id, location_id, on_hand)
  VALUES ($1, $2, $3)
`;
