import { ColumnType, DataSource, DataSourceOptions } from 'typeorm';

export const dataSourceFactory = (options: DataSourceOptions): DataSource => {
  const dataSource = new DataSource(options);
  dataSource.driver.supportedDataTypes.push('vector' as ColumnType);
  dataSource.driver.withLengthColumnTypes.push('vector' as ColumnType);
  return dataSource;
};
