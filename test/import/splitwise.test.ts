import { describe, expect, it } from 'vitest';
import { parseSplitwiseCsv, suggestedCategoryName } from '../../src/import/splitwise';
import type { ParsedOrdinary } from '../../src/import/types';

// The header and every data row in REAL_ROWS are transcribed verbatim from
// a real 284-row Splitwise export (see docs/plan.md's PR 10 notes for the
// net-vs-share modeling this spec proves). This file IS the parser's spec.

const HEADER = 'Date,Description,Category,Cost,Currency,Steve,kristine sandt,Palle Helenius,Katherine Atwill';
const OUR_TWO = ['kristine sandt', 'Palle Helenius'];

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows, ''].join('\n');
}

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return result.rows as ParsedOrdinary[];
}

// 285 real data rows (284 real transactions + the trailing "Total balance" footer).
const REAL_ROWS = [
  '2025-05-20,Receptacles 10 pack,General,27.54,USD,-6.89,-6.89,20.66,-6.88',
  '2025-05-20,Receptacles Faceplates,General,7.73,USD,-1.93,-1.93,5.79,-1.93',
  '2025-05-22,Smoke Detectors,General,74.19,USD,-18.55,-18.55,55.64,-18.54',
  '2025-05-22,Floss and rxBars,General,24.16,USD,0.00,0.00,24.16,-24.16',
  '2025-06-26,Groceires,Groceries,70.10,USD,-17.52,-17.53,-17.52,52.57',
  '2025-06-26,Pho,General,63.88,USD,0.00,-20.00,40.00,-20.00',
  '2025-06-28,Sushi,Dining out,32.00,USD,0.00,-8.00,-8.00,16.00',
  '2025-06-28,Gas for liberty,Gas/fuel,28.00,USD,0.00,-9.33,-9.33,18.66',
  '2025-06-30,Mexican dinner,Dining out,17.00,USD,0.00,17.00,0.00,-17.00',
  '2025-06-30,Camping expenses ,Entertainment - Other,93.12,USD,0.00,-93.12,0.00,93.12',
  '2025-07-01,July rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2025-07-02,kristine s. paid Palle H.,Payment,1008.35,USD,0.00,1008.35,-1008.35,0.00',
  '2025-07-02,Palle H. paid Katherine A.,Payment,1746.95,USD,0.00,0.00,1746.95,-1746.95',
  '2025-07-08,Liberty tolls,General,28.00,USD,28.00,-9.34,-9.33,-9.33',
  '2025-07-08,Mi la cay,General,60.00,USD,-11.00,0.00,-14.00,25.00',
  '2025-07-09,Costco Household ,Household supplies,204.00,USD,-51.00,-51.00,-51.00,153.00',
  '2025-07-09,Costco magnesium for Gracie ,Household supplies,16.00,USD,0.00,0.00,-16.00,16.00',
  '2025-07-09,Costco Steve Party,Household supplies,145.00,USD,-145.00,0.00,0.00,145.00',
  '2025-07-12,Trash bags,Trash,7.49,USD,-1.87,-1.87,5.62,-1.88',
  '2025-07-14,Ethernet Cable to move wifi to middle of house ,TV/Phone/Internet,16.43,USD,-4.10,-4.11,12.32,-4.11',
  '2025-07-14,Electrical Outlets,Electricity,27.54,USD,0.00,0.00,27.54,-27.54',
  '2025-07-15,Verizon July,TV/Phone/Internet,49.99,USD,-12.50,-12.50,-12.50,37.50',
  '2025-07-19,Gas bill July,Heat/gas,45.84,USD,-11.46,-11.46,-11.46,34.38',
  '2025-07-24,Microwave refund,General,222.58,USD,0.00,0.00,-222.58,222.58',
  '2025-07-27,August rent ,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2025-07-30,Pepco July,General,169.85,USD,-42.46,-42.46,-42.47,127.39',
  '2025-08-01,kristine s. paid Palle H.,Payment,582.74,USD,0.00,582.74,-582.74,0.00',
  '2025-08-01,Palle H. paid Katherine A.,Payment,1586.41,USD,0.00,0.00,1586.41,-1586.41',
  '2025-08-05,Groceires,Groceries,137.20,USD,-34.30,-34.30,-34.30,102.90',
  '2025-08-06,Groceries ,Groceries,107.00,USD,-26.75,-26.75,80.25,-26.75',
  '2025-08-06,kristine s. paid Katherine A.,Payment,580.12,USD,0.00,580.12,0.00,-580.12',
  '2025-08-06,Electrical stuff,Electricity,39.00,USD,0.00,0.00,39.00,-39.00',
  '2025-08-10,Pho,General,66.65,USD,0.00,0.00,-66.65,66.65',
  '2025-08-12,Groceries,Groceries,106.15,USD,-26.54,-26.54,-26.54,79.62',
  '2025-08-15,Groceries ,Groceries,30.00,USD,-7.50,-7.50,22.50,-7.50',
  '2025-08-15,Verizon bill august,TV/Phone/Internet,49.99,USD,-12.49,-12.50,-12.50,37.49',
  '2025-08-15,coconut,Groceries,44.00,USD,33.00,-11.00,-11.00,-11.00',
  '2025-08-17,Groceries,Groceries,132.00,USD,-33.00,-33.00,-33.00,99.00',
  '2025-08-18,Gas bill August,Heat/gas,91.00,USD,-22.75,-22.75,-22.75,68.25',
  '2025-08-19,Settle all balances,General,420.83,USD,420.83,0.00,0.00,-420.83',
  '2025-08-21,September Rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2025-08-22,Trader Joes,Groceries,70.50,USD,-17.62,-17.62,52.87,-17.63',
  '2025-08-22,Giat,General,101.98,USD,-25.50,-25.50,76.49,-25.49',
  '2025-08-27,Water bill april-july,Water,187.72,USD,-46.93,-46.93,-46.93,140.79',
  '2025-08-29,Groceires,Groceries,141.82,USD,-35.45,-35.46,-35.46,106.37',
  '2025-08-29,Gracie yogurt,Groceries,14.00,USD,0.00,0.00,-14.00,14.00',
  '2025-08-30,Groceries,Groceries,65.00,USD,-16.25,-16.25,-16.25,48.75',
  '2025-08-31,Box beam level ,General,35.00,USD,-35.00,0.00,35.00,0.00',
  '2025-08-31,Groceries,Groceries,30.00,USD,-7.50,-7.50,-7.50,22.50',
  '2025-09-01,Pool!,General,21.00,USD,-7.00,-7.00,0.00,14.00',
  '2025-09-02,Pepco August,General,249.91,USD,-62.48,-62.48,-62.47,187.43',
  '2025-09-03,Vegies,General,9.92,USD,-2.48,-2.48,7.44,-2.48',
  '2025-09-03,Palle H. paid Katherine A.,Payment,1400.00,USD,0.00,0.00,1400.00,-1400.00',
  '2025-09-03,kristine s. paid Katherine A.,Payment,800.00,USD,0.00,800.00,0.00,-800.00',
  '2025-09-03,trader joes,Groceries,45.00,USD,33.75,-11.25,-11.25,-11.25',
  '2025-09-04,Meat order,General,336.60,USD,-84.15,-84.15,-84.15,252.45',
  '2025-09-04,Giant ,General,21.40,USD,-5.35,-5.35,16.05,-5.35',
  '2025-09-08,Ecobee Thermostat,General,48.39,USD,-12.10,-12.10,36.29,-12.09',
  '2025-09-09,Groceries,Groceries,61.37,USD,-15.35,-15.34,-15.34,46.03',
  '2025-09-11,Settle all balances,General,326.09,USD,326.09,0.00,0.00,-326.09',
  '2025-09-15,Grocerirs ,General,47.76,USD,-11.94,-11.94,-11.94,35.82',
  '2025-09-16,September verizon bill,TV/Phone/Internet,49.99,USD,-12.50,-12.49,-12.50,37.49',
  '2025-09-16,Tree of heaven removal,General,60.00,USD,-30.00,0.00,0.00,30.00',
  '2025-09-17,Groceries,Groceries,70.00,USD,-17.50,52.50,-17.50,-17.50',
  '2025-09-18,Gas bill september,Heat/gas,91.00,USD,-22.75,-22.75,-22.75,68.25',
  '2025-09-22,Groceries,Groceries,85.76,USD,-21.44,-21.44,-21.44,64.32',
  '2025-09-22,Groceries ,Groceries,113.12,USD,-28.28,-28.28,-28.28,84.84',
  '2025-09-23,Settle all balances,General,144.41,USD,144.41,0.00,0.00,-144.41',
  '2025-09-24,October rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2025-09-25,Groceries ,Groceries,108.80,USD,-27.20,-27.20,81.60,-27.20',
  '2025-09-28,Groceries ,Groceries,101.67,USD,-25.42,-25.42,76.26,-25.42',
  '2025-09-29,Pepco September,General,270.27,USD,-67.56,-67.57,-67.57,202.70',
  '2025-09-30,Palle H. paid Katherine A.,Payment,1300.00,USD,0.00,0.00,1300.00,-1300.00',
  '2025-09-30,kristine s. paid Palle H.,Payment,625.20,USD,0.00,625.20,-625.20,0.00',
  '2025-09-30,Palle H. paid Katherine A.,Payment,300.00,USD,0.00,0.00,300.00,-300.00',
  '2025-09-30,kristine s. paid Katherine A.,Payment,500.00,USD,0.00,500.00,0.00,-500.00',
  '2025-09-30,Groceries,Groceries,76.90,USD,-19.23,-19.22,-19.23,57.68',
  '2025-09-30,Dishwasher and laundry detergent,Household supplies,33.89,USD,-8.47,-8.48,-8.47,25.42',
  '2025-10-02,Soda stream ,Groceries,38.94,USD,29.21,-9.74,-9.73,-9.74',
  '2025-10-02,Lawn,General,165.00,USD,82.50,0.00,0.00,-82.50',
  '2025-10-03,Groceries ,Groceries,35.90,USD,-8.98,-8.97,26.93,-8.98',
  '2025-10-03,Propane,General,63.30,USD,-15.83,-15.82,47.47,-15.82',
  '2025-10-03,Wing nuts for sink clamp,General,7.10,USD,0.00,0.00,7.10,-7.10',
  '2025-10-06,Groceries ,Groceries,67.24,USD,-16.81,-16.81,-16.81,50.43',
  '2025-10-08,Vent for basement ceiling ,General,31.39,USD,-7.84,-7.85,23.54,-7.85',
  '2025-10-12,Groceries Giat,Groceries,73.18,USD,-18.29,-18.30,54.88,-18.29',
  '2025-10-12,Groceries ,Groceries,117.53,USD,-29.38,-29.39,-29.38,88.15',
  '2025-10-14,Settle all balances,General,127.11,USD,127.11,0.00,0.00,-127.11',
  '2025-10-16,October Verizon bill,TV/Phone/Internet,49.99,USD,-12.49,-12.50,-12.50,37.49',
  '2025-10-17,kristine s. paid Palle H.,Payment,400.09,USD,0.00,400.09,-400.09,0.00',
  '2025-10-17,Liberty delight order,General,292.14,USD,-73.04,-73.03,-73.03,219.10',
  '2025-10-17,Gas october ,Heat/gas,91.00,USD,-22.75,-22.75,-22.75,68.25',
  '2025-10-17,Groceries giant ,Groceries,94.20,USD,-23.55,-23.55,70.65,-23.55',
  '2025-10-18,Groceires,Groceries,65.42,USD,-16.36,-16.36,-16.35,49.07',
  '2025-10-27,Groceries,Groceries,80.32,USD,-20.08,-20.08,-20.08,60.24',
  '2025-10-27,November rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2025-10-27,November mortgage,Mortgage,2000.00,USD,-2000.00,0.00,0.00,2000.00',
  '2025-10-28,Costco,Household supplies,418.60,USD,-104.65,-104.65,-104.65,313.95',
  '2025-10-29,October electric bill,Electricity,267.04,USD,-66.76,-66.76,-66.76,200.28',
  '2025-10-31,kristine s. paid Katherine A.,Payment,512.00,USD,0.00,512.00,0.00,-512.00',
  '2025-10-31,Palle H. paid Katherine A.,Payment,1880.00,USD,0.00,0.00,1880.00,-1880.00',
  '2025-10-31,kristine s. paid Palle H.,Payment,688.19,USD,0.00,688.19,-688.19,0.00',
  '2025-11-04,Groceries,Groceries,115.48,USD,-38.49,-38.49,0.00,76.98',
  '2025-11-05,Steve paid Katherine A.,Payment,2326.11,USD,2326.11,0.00,0.00,-2326.11',
  '2025-11-10,Groceries,Groceries,203.55,USD,-67.85,-67.85,0.00,135.70',
  '2025-11-17,Gas November,Heat/gas,91.00,USD,-22.75,-22.75,-22.75,68.25',
  '2025-11-17,Grocery ,Groceries,74.50,USD,-24.83,49.67,0.00,-24.84',
  '2025-11-18,November internet,TV/Phone/Internet,49.99,USD,-12.49,-12.50,-12.50,37.49',
  '2025-11-19,Plates,General,24.00,USD,-6.00,-6.00,-6.00,18.00',
  '2025-11-19,Groceries,Groceries,107.63,USD,-35.88,-35.88,0.00,71.76',
  '2025-11-20,Meat!,General,194.03,USD,-64.68,-64.68,0.00,129.36',
  '2025-11-20,Water bill,Water,389.79,USD,-97.45,-97.45,-97.45,292.35',
  '2025-11-23,December rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2025-11-23,December mortgage,Mortgage,2000.00,USD,-2000.00,0.00,0.00,2000.00',
  '2025-11-24,Grocrires ,General,220.32,USD,-73.44,-73.44,0.00,146.88',
  '2025-12-01,Groceries,Groceries,137.03,USD,-45.67,-45.68,0.00,91.35',
  '2025-12-01,Pepco November,General,187.70,USD,-46.93,-46.93,-46.92,140.78',
  '2025-12-03,Palle H. paid Katherine A.,Payment,2000.00,USD,0.00,0.00,2000.00,-2000.00',
  '2025-12-03,kristine s. paid Palle H.,Payment,1073.22,USD,0.00,1073.22,-1073.22,0.00',
  '2025-12-04,Steve paid Katherine A.,Payment,2568.32,USD,2568.32,0.00,0.00,-2568.32',
  '2025-12-09,Groceries,Groceries,99.00,USD,-33.00,-33.00,0.00,66.00',
  '2025-12-15,Groceries,Groceries,92.67,USD,-23.17,-23.17,-23.16,69.50',
  '2025-12-16,Internet December,TV/Phone/Internet,49.99,USD,-12.50,-12.50,-12.50,37.50',
  '2025-12-17,Lyft to boogie ,Taxi,34.96,USD,0.00,-11.66,23.31,-11.65',
  '2025-12-17,January rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2025-12-18,Groceries ,Groceries,77.22,USD,-19.30,-19.31,57.91,-19.30',
  '2025-12-18,Groceries,Groceries,41.99,USD,-10.49,-10.50,-10.50,31.49',
  '2025-12-19,Gas December,Heat/gas,91.00,USD,-22.75,-22.75,-22.75,68.25',
  '2025-12-19,Meat!,General,203.70,USD,-50.92,-50.93,-50.92,152.77',
  '2025-12-22,Groceries ,Groceries,66.45,USD,-16.61,-16.61,49.84,-16.62',
  '2025-12-23,Groceries,Groceries,140.35,USD,-35.09,-35.08,-35.09,105.26',
  '2025-12-24,Groceires,Groceries,48.93,USD,-12.23,-12.24,-12.23,36.70',
  '2025-12-24,Electrical stuff ,Electricity,42.29,USD,-21.14,0.00,42.29,-21.15',
  '2025-12-27,Electrical Connectors ,Electricity,41.29,USD,-20.65,0.00,41.29,-20.64',
  '2025-12-29,Pepco December,General,204.20,USD,-51.05,-51.05,-51.05,153.15',
  '2025-12-29,Groceries ,Groceries,203.25,USD,-50.82,-50.81,-50.81,152.44',
  '2025-12-29,Electrical stuff ,Electricity,152.67,USD,-76.34,0.00,152.67,-76.33',
  '2025-12-31,Thai,Dining out,160.00,USD,-40.00,-40.00,120.00,-40.00',
  '2026-01-01,Palle H. paid Katherine A.,Payment,2173.51,USD,0.00,0.00,2173.51,-2173.51',
  '2026-01-01,kristine s. paid Palle H.,Payment,1445.37,USD,0.00,1445.37,-1445.37,0.00',
  '2026-01-04,Groceries ,Groceries,80.00,USD,-20.00,-20.00,60.00,-20.00',
  '2026-01-05,Groceries ,Groceries,91.85,USD,-22.96,-22.97,-22.96,68.89',
  '2026-01-12,Groceries,Groceries,46.74,USD,-11.68,-11.69,-11.69,35.06',
  '2026-01-13,Cereal ,Groceries,7.65,USD,-1.92,-1.91,5.74,-1.91',
  '2026-01-13,Groceries,Groceries,121.31,USD,-30.33,-30.33,-30.32,90.98',
  '2026-01-14,Steve paid Katherine A.,Payment,539.64,USD,539.64,0.00,0.00,-539.64',
  '2026-01-14,Breaker for kitchen,Household supplies,47.91,USD,-23.95,0.00,47.91,-23.96',
  '2026-01-16,January internet,TV/Phone/Internet,49.99,USD,-12.49,-12.50,-12.50,37.49',
  '2026-01-16,Kebab palace,Dining out,110.00,USD,82.50,-27.50,-27.50,-27.50',
  '2026-01-19,Interfusion hotel,Hotel,680.92,USD,-170.23,-170.23,-170.23,510.69',
  '2026-01-20,January gas bill,Heat/gas,110.00,USD,-27.50,-27.50,-27.50,82.50',
  '2026-01-20,Groceries,Groceries,146.13,USD,-36.53,-36.53,-36.54,109.60',
  '2026-01-22,Groceries ,Groceries,40.15,USD,-10.04,-10.03,30.11,-10.04',
  '2026-01-22,Electrical ,Electricity,145.20,USD,-72.60,0.00,145.20,-72.60',
  '2026-01-23,Groceries ,Groceries,35.07,USD,-8.77,-8.76,26.30,-8.77',
  '2026-01-24,Groceries ,Groceries,250.50,USD,-62.62,-62.63,187.88,-62.63',
  '2026-01-24,February rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2026-01-27,Dishwasher detergent,Household supplies,37.05,USD,-9.26,-9.26,-9.27,27.79',
  '2026-01-28,Pepco January,General,310.28,USD,-77.57,-77.57,-77.57,232.71',
  '2026-01-28,kristine s. paid Katherine A.,Payment,1000.00,USD,0.00,1000.00,0.00,-1000.00',
  '2026-01-28,Palle H. paid Katherine A.,Payment,1200.00,USD,0.00,0.00,1200.00,-1200.00',
  '2026-01-28,kristine s. paid Palle H.,Payment,500.00,USD,0.00,500.00,-500.00,0.00',
  '2026-01-28,Groceries,Groceries,129.78,USD,-32.45,-32.44,-32.44,97.33',
  '2026-01-29,Water bill 10/08-01/15,Water,389.06,USD,-97.27,-97.26,-97.27,291.80',
  '2026-01-29,Meat order,General,350.86,USD,-87.71,-87.71,-87.72,263.14',
  '2026-01-30,Groceries,Groceries,270.00,USD,-67.50,-67.50,-67.50,202.50',
  '2026-02-01,Electrical switches ,Electricity,26.29,USD,-13.15,0.00,26.29,-13.14',
  '2026-02-02,Groceries,Groceries,136.67,USD,-34.17,-34.17,-34.16,102.50',
  '2026-02-04,Settle all balances,General,771.62,USD,771.62,0.00,0.00,-771.62',
  '2026-02-06,Groceries ,Groceries,40.00,USD,-10.00,-10.00,30.00,-10.00',
  '2026-02-17,Internet Feb,TV/Phone/Internet,49.99,USD,-12.50,-12.50,-12.50,37.50',
  '2026-02-17,Gas Feb,Heat/gas,110.00,USD,-27.50,-27.50,-27.50,82.50',
  '2026-02-23,March rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2026-02-23,Groceries ,Groceries,103.87,USD,-25.97,-25.97,-25.97,77.91',
  '2026-02-26,Giant ,General,31.08,USD,23.31,-7.77,-7.77,-7.77',
  '2026-03-01,Groceries ,Groceries,62.78,USD,-15.70,-15.69,47.09,-15.70',
  '2026-03-01,Palle H. paid Katherine A.,Payment,2000.00,USD,0.00,0.00,2000.00,-2000.00',
  '2026-03-01,kristine s. paid Katherine A.,Payment,300.00,USD,0.00,300.00,0.00,-300.00',
  '2026-03-02,Electricity Feb,Electricity,301.12,USD,-75.28,-75.28,-75.28,225.84',
  '2026-03-03,Meat order,General,333.04,USD,-83.26,-83.26,-83.26,249.78',
  '2026-03-03,Groceries ,Groceries,153.28,USD,-38.32,-38.32,-38.32,114.96',
  '2026-03-09,Groceries,Groceries,112.57,USD,-28.15,-28.14,-28.14,84.43',
  '2026-03-10,Madjam hotel,Hotel,349.60,USD,0.00,-174.80,-174.80,349.60',
  '2026-03-13,Groceries ,Groceries,147.15,USD,-36.79,-36.79,110.36,-36.78',
  '2026-03-13,Miami Taxes,General,506.00,USD,0.00,-253.00,-253.00,506.00',
  '2026-03-13,Palle H. paid Katherine A.,Payment,800.00,USD,0.00,0.00,800.00,-800.00',
  '2026-03-13,kristine s. paid Palle H.,Payment,1141.61,USD,0.00,1141.61,-1141.61,0.00',
  '2026-03-14,Groceries ,Groceries,60.00,USD,-15.00,-15.00,45.00,-15.00',
  '2026-03-16,Internet March,TV/Phone/Internet,49.99,USD,-12.49,-12.50,-12.50,37.49',
  '2026-03-16,Gas March,Heat/gas,110.00,USD,-27.50,-27.50,-27.50,82.50',
  '2026-03-16,Groceries,Groceries,125.64,USD,-31.41,-31.41,-31.41,94.23',
  '2026-03-19,Groceries ,Groceries,20.00,USD,-5.00,-5.00,15.00,-5.00',
  '2026-03-22,Groceries,Groceries,451.03,USD,-112.75,-112.76,-112.76,338.27',
  '2026-03-23,Groceries,Groceries,161.07,USD,-40.26,-40.27,-40.27,120.80',
  '2026-03-27,April Rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2026-03-30,Electricity March,Electricity,307.62,USD,-76.90,-76.91,-76.91,230.72',
  '2026-03-30,Groceries,Groceries,137.59,USD,-34.40,-34.39,-34.40,103.19',
  '2026-04-01,kristine s. paid Katherine A.,Payment,800.00,USD,0.00,800.00,0.00,-800.00',
  '2026-04-01,Palle H. paid Katherine A.,Payment,2200.00,USD,0.00,0.00,2200.00,-2200.00',
  '2026-04-10,Groceries ,Groceries,105.00,USD,-26.25,-26.25,78.75,-26.25',
  '2026-04-13,Groceries,Groceries,118.91,USD,-29.72,-29.73,-29.73,89.18',
  '2026-04-16,Verizon bill april,TV/Phone/Internet,49.99,USD,-12.49,-12.50,-12.50,37.49',
  '2026-04-16,Meat!,General,591.17,USD,-147.80,-147.79,-147.79,443.38',
  '2026-04-17,April gas,General,110.00,USD,-27.50,-27.50,-27.50,82.50',
  '2026-04-18,Groceries ,Groceries,153.00,USD,-38.25,-38.25,114.75,-38.25',
  '2026-04-20,May rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2026-04-20,Groceries,Groceries,122.72,USD,-30.68,-30.68,-30.68,92.04',
  '2026-04-22,Chlorine,General,90.88,USD,-22.72,-22.72,-22.72,68.16',
  '2026-04-26,Whole foods ,Groceries,112.00,USD,84.00,-28.00,-28.00,-28.00',
  '2026-04-27,Groceries,Groceries,142.02,USD,-35.50,-35.51,-35.51,106.52',
  '2026-04-28,Electricity April,Electricity,283.72,USD,-70.93,-70.93,-70.93,212.79',
  '2026-05-01,Palle H. paid Katherine A.,Payment,2200.00,USD,0.00,0.00,2200.00,-2200.00',
  '2026-05-01,kristine s. paid Palle H.,Payment,2121.50,USD,0.00,2121.50,-2121.50,0.00',
  '2026-05-02,Groceries ,Groceries,36.50,USD,-9.12,-9.13,27.37,-9.12',
  '2026-05-04,Water bill Jan-April,Water,302.92,USD,-75.73,-75.73,-75.73,227.19',
  '2026-05-04,Groceries,Groceries,151.82,USD,-37.96,-37.95,-37.96,113.87',
  '2026-05-05,Steve paid Katherine A.,Payment,1166.52,USD,1166.52,0.00,0.00,-1166.52',
  '2026-05-07,Groceries ,Groceries,114.86,USD,-28.71,86.14,-28.72,-28.71',
  '2026-05-11,Groceries,Groceries,148.55,USD,-37.13,-37.14,-37.14,111.41',
  '2026-05-16,Verizon May,TV/Phone/Internet,49.99,USD,-12.50,-12.50,-12.49,37.49',
  '2026-05-16,Gas bill May,Heat/gas,110.00,USD,-27.50,-27.50,-27.50,82.50',
  '2026-05-18,Lawn 5-4,General,110.00,USD,55.00,0.00,0.00,-55.00',
  '2026-05-18,Groceries,Groceries,138.02,USD,-34.51,-34.50,-34.50,103.51',
  '2026-05-18,Hot tub test strips,General,32.22,USD,-8.05,-8.06,24.17,-8.06',
  '2026-05-20,June rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2026-05-26,Groceries,Groceries,157.56,USD,-39.39,-39.39,-39.39,118.17',
  '2026-05-29,Palle H. paid Katherine A.,Payment,1300.00,USD,0.00,0.00,1300.00,-1300.00',
  '2026-05-29,Groceires,Groceries,53.19,USD,-13.30,-13.30,-13.29,39.89',
  '2026-05-29,Meat delivery,General,515.14,USD,-128.78,-128.78,-128.79,386.35',
  '2026-06-01,Pepco May,General,274.67,USD,-68.67,-68.67,-68.67,206.01',
  '2026-06-01,Groceries,Groceries,59.93,USD,-14.99,-14.98,-14.98,44.95',
  '2026-06-01,Settle all balances,General,358.53,USD,358.53,0.00,0.00,-358.53',
  '2026-06-05,kristine s. paid Palle H.,Payment,900.00,USD,0.00,900.00,-900.00,0.00',
  '2026-06-05,Palle H. paid Katherine A.,Payment,800.00,USD,0.00,0.00,800.00,-800.00',
  '2026-06-05,kristine s. paid Katherine A.,Payment,400.00,USD,0.00,400.00,0.00,-400.00',
  '2026-06-07,Groceries ,Groceries,118.30,USD,-29.58,-29.57,-29.58,88.73',
  '2026-06-09,Groceires,Groceries,36.03,USD,-9.01,-9.01,-9.01,27.03',
  '2026-06-12,Groceries ,Groceries,38.52,USD,-9.63,-9.63,28.89,-9.63',
  '2026-06-15,Propane ,General,27.02,USD,-6.76,-6.76,20.27,-6.75',
  '2026-06-16,Verizon June,TV/Phone/Internet,49.99,USD,-12.50,-12.49,-12.50,37.49',
  '2026-06-16,June Gas,Heat/gas,110.00,USD,-27.50,-27.50,-27.50,82.50',
  "2026-06-20,Trader Joe's ,Groceries,56.26,USD,42.19,-14.07,-14.06,-14.06",
  '2026-06-22,Groceries,Groceries,93.28,USD,-23.32,-23.32,-23.32,69.96',
  '2026-06-23,July rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2026-06-24,Groceries ,Groceries,49.54,USD,-12.38,-12.38,37.15,-12.39',
  '2026-06-26,Groceries ,Groceries,97.63,USD,-24.41,73.22,-24.40,-24.41',
  '2026-06-27,Pool,General,14.00,USD,0.00,-7.00,-7.00,14.00',
  '2026-06-28,Dishwasher detergent,Household supplies,40.00,USD,-10.00,-10.00,-10.00,30.00',
  '2026-06-30,Pepco june,General,389.06,USD,-97.26,-97.27,-97.26,291.79',
  '2026-06-30,Groceries,Groceries,137.74,USD,-34.44,-34.43,-34.44,103.31',
  '2026-07-01,Palle H. paid Katherine A.,Payment,1100.00,USD,0.00,0.00,1100.00,-1100.00',
  '2026-07-01,kristine s. paid Katherine A.,Payment,600.00,USD,0.00,600.00,0.00,-600.00',
  '2026-07-01,Palle H. paid Katherine A.,Payment,500.00,USD,0.00,0.00,500.00,-500.00',
  '2026-07-01,kristine s. paid Palle H.,Payment,441.70,USD,0.00,441.70,-441.70,0.00',
  '2026-07-06,Groceries,Groceries,94.97,USD,-23.74,-23.75,-23.74,71.23',
  '2026-07-07,Beef tallow,General,12.00,USD,-3.00,-3.00,-3.00,9.00',
  '2026-07-07,Meat,General,297.69,USD,-74.42,-74.42,-74.42,223.26',
  '2026-07-09,Sodastream,General,72.04,USD,-18.01,-18.01,-18.01,54.03',
  '2026-07-11,Groceries,Groceries,124.49,USD,-31.12,-31.12,-31.13,93.37',
  '2026-07-14,Groceries ,Groceries,70.78,USD,-17.69,-17.69,-17.70,53.08',
  '2026-07-15,Steve paid Katherine A.,Payment,422.58,USD,422.58,0.00,0.00,-422.58',
  '2026-07-16,Groceries ,Groceries,101.70,USD,-25.42,-25.43,76.28,-25.43',
  '2026-07-16,August rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00',
  '2026-07-16,Verizon July,TV/Phone/Internet,49.99,USD,-12.50,-12.49,-12.50,37.49',
  '2026-07-18,Gas bill July,Heat/gas,129.00,USD,-32.25,-32.25,-32.25,96.75',
  '2026-07-19,Groceries ,Groceries,148.57,USD,-37.14,-37.15,-37.14,111.43',
  '2026-07-21,Warer bill July,General,329.65,USD,-82.41,-82.42,-82.41,247.24',
  '2026-07-21,7-10 mows,General,165.00,USD,82.50,0.00,0.00,-82.50',
  '2026-07-23,Groceries ,Groceries,23.55,USD,-5.89,-5.89,-5.88,17.66',
  '2026-08-01,Groceries,Groceries,133.35,USD,-33.33,-33.34,-33.34,100.01',
  '2026-08-03,Pepco July,General,453.62,USD,-113.40,-113.41,-113.41,340.22',
  '2026-08-04,Groceries ,Groceries,110.00,USD,-27.50,-27.50,82.50,-27.50',
  '2026-08-04,Palle H. paid Katherine A.,Payment,1483.07,USD,0.00,0.00,1483.07,-1483.07',
  '2026-08-04,Groceries,Groceries,205.00,USD,-51.25,-51.25,-51.25,153.75',
  '2026-08-06,Sushi,Dining out,27.00,USD,0.00,-8.91,0.00,8.91',
  '2026-08-10,Groceries,Groceries,114.74,USD,-28.69,-28.68,-28.68,86.05',
  '2026-08-10,Swing Fling Hotel,Hotel,111.09,USD,0.00,0.00,111.09,-111.09',
  '2026-08-14,Groceries ,Groceries,109.00,USD,-27.25,81.75,-27.25,-27.25',
  '2026-08-14,Palle H. paid Katherine A.,Payment,1500.00,USD,0.00,0.00,1500.00,-1500.00',
  '2026-08-14,kristine s. paid Palle H.,Payment,1434.96,USD,0.00,1434.96,-1434.96,0.00',
  '2026-08-14,Swing fling,General,111.09,USD,0.00,111.09,0.00,-111.09',
  '2026-08-17,Verizon bill august,TV/Phone/Internet,49.99,USD,-12.50,-12.49,-12.50,37.49',
  '2026-08-17,Gas bill august,Heat/gas,129.00,USD,-32.25,-32.25,-32.25,96.75',
  '2026-08-17,Groceries,Groceries,197.50,USD,-49.37,-49.37,-49.38,148.12',
  '2026-08-19,Total balance, , ,USD,-528.65,16.98,360.55,151.12',
];

const REAL_FILE = csv(...REAL_ROWS);

describe('participant discovery', () => {
  it('reads the dynamic person columns from the header, in order', () => {
    const result = parseSplitwiseCsv(csv(), { members: [] });
    expect(result.participants).toEqual(['Steve', 'kristine sandt', 'Palle Helenius', 'Katherine Atwill']);
  });
});

describe('net position for the selected members', () => {
  it('a housemate-fronted rent row nets negative — a real expense', () => {
    const result = parseSplitwiseCsv(
      csv('2025-07-01,July rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00'),
      { members: OUR_TWO },
    );
    const [row] = ordinaries(result);
    expect(row?.amountMinor).toBe(-170000);
    expect(row?.providerCategory).toBe('Rent');
  });

  it('a row the selected members fronted themselves nets POSITIVE — the group reimbursing them', () => {
    const result = parseSplitwiseCsv(
      csv('2025-08-06,Groceries ,Groceries,107.00,USD,-26.75,-26.75,80.25,-26.75'),
      { members: OUR_TWO },
    );
    const [row] = ordinaries(result);
    // Palle paid the full $107; the pair's true share is $53.50 — the
    // Splitwise line is the reimbursement that cancels the excess $53.50
    // already recorded when the $107 bank charge was imported.
    expect(row?.amountMinor).toBe(5350);
  });
});

describe('settlement detection', () => {
  it('a Payment-category row between a selected member and someone outside the budget is imported, uncategorized', () => {
    const result = parseSplitwiseCsv(
      csv('2025-07-02,Palle H. paid Katherine A.,Payment,1746.95,USD,0.00,0.00,1746.95,-1746.95'),
      { members: OUR_TWO },
    );
    const [row] = ordinaries(result);
    expect(row?.amountMinor).toBe(174695); // Palle's debt to Katherine shrank — his net position rose
    expect(row?.providerCategory).toBeNull(); // paying off debt is not a new expense
  });

  it('"Settle all balances" is recognized as a settlement even outside the Payment category (synthetic — the real file\'s examples all happen to net to zero for this pair)', () => {
    // Steve settles up with kristine for $25 (Steve +25, kristine -25) —
    // sums to zero across the row, nets to -25 for our pair, and the
    // description (not the Category column, which here is "General")
    // is what must trigger settlement detection.
    const result = parseSplitwiseCsv(
      csv('2026-01-01,Settle all balances,General,25.00,USD,25.00,-25.00,0.00,0.00'),
      { members: OUR_TWO },
    );
    const [row] = ordinaries(result);
    expect(row?.amountMinor).toBe(-2500);
    expect(row?.providerCategory).toBeNull();
  });
});

describe('rows with no effect on the selected members', () => {
  it('a Payment strictly between the two selected members nets to zero and is skipped', () => {
    // kristine paying Palle back is money moving WITHIN the shared budget —
    // nothing for the group outside it, so it must not create a phantom
    // Splitwise transaction.
    const result = parseSplitwiseCsv(
      csv('2025-07-02,kristine s. paid Palle H.,Payment,1008.35,USD,0.00,1008.35,-1008.35,0.00'),
      { members: OUR_TWO },
    );
    expect(result.rows).toEqual([]);
    expect(result.skipped).toEqual([{ reference: 'kristine s. paid Palle H.', reason: 'no net effect on the selected people' }]);
  });

  it('a row involving only non-selected people nets to zero and is skipped', () => {
    const result = parseSplitwiseCsv(
      csv('2025-08-19,Settle all balances,General,420.83,USD,420.83,0.00,0.00,-420.83'),
      { members: OUR_TWO },
    );
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('no net effect on the selected people');
  });
});

describe('the file total row', () => {
  it('the trailing "Total balance" row is excluded, not imported as a transaction', () => {
    const result = parseSplitwiseCsv(
      csv('2025-07-01,July rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00', '2026-08-19,Total balance, , ,USD,-528.65,16.98,360.55,151.12'),
      { members: OUR_TWO },
    );
    expect(result.rows).toHaveLength(1);
    expect(result.skipped.some((s) => s.reason.includes('file total'))).toBe(true);
  });
});

describe('import id uniqueness', () => {
  it('genuinely repeated same-day rows (synthetic — mirrors becu.test.ts\'s duplicate-Zelle-rows case) get distinct import ids', () => {
    const result = parseSplitwiseCsv(
      csv(
        '2026-07-01,Palle H. paid Katherine A.,Payment,500.00,USD,0.00,0.00,500.00,-500.00',
        '2026-07-01,Palle H. paid Katherine A.,Payment,500.00,USD,0.00,0.00,500.00,-500.00',
      ),
      { members: OUR_TWO },
    );
    const rows = ordinaries(result);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.importId).not.toBe(rows[1]?.importId);
  });

  it('is independent of which members are selected — the row identity is the same regardless', () => {
    // Every Splitwise row sums to zero across ALL participants by
    // construction, so "select everyone" isn't a usable comparison (it
    // trivially nets to zero for every row) — compare two different
    // non-trivial subsets instead.
    const row = '2025-07-01,July rent,Rent,1700.00,USD,0.00,-850.00,-850.00,1700.00';
    const withOurTwo = parseSplitwiseCsv(csv(row), { members: OUR_TWO });
    const withJustPalle = parseSplitwiseCsv(csv(row), { members: ['Palle Helenius'] });
    expect(ordinaries(withOurTwo)[0]?.importId).toBe(ordinaries(withJustPalle)[0]?.importId);
  });
});

describe('category suggestions', () => {
  it('maps confident labels onto the seeded category set', () => {
    expect(suggestedCategoryName('Groceries')).toBe('Groceries');
    expect(suggestedCategoryName('Dining out')).toBe('Dining Out');
    expect(suggestedCategoryName('Rent')).toBe('Rent/Mortgage');
    expect(suggestedCategoryName('Mortgage')).toBe('Rent/Mortgage');
    expect(suggestedCategoryName('Gas/fuel')).toBe('Transportation');
    expect(suggestedCategoryName('Taxi')).toBe('Transportation');
    expect(suggestedCategoryName('Electricity')).toBe('Utilities');
    expect(suggestedCategoryName('Heat/gas')).toBe('Utilities');
    expect(suggestedCategoryName('Water')).toBe('Utilities');
    expect(suggestedCategoryName('Trash')).toBe('Utilities');
    expect(suggestedCategoryName('TV/Phone/Internet')).toBe('Utilities');
    expect(suggestedCategoryName('Entertainment - Other')).toBe('Fun Money');
  });

  it('leaves vague labels for the user (or a payee rule) to decide', () => {
    expect(suggestedCategoryName('General')).toBeNull();
    expect(suggestedCategoryName('Household supplies')).toBeNull();
    expect(suggestedCategoryName('Hotel')).toBeNull();
  });
});

describe('the real 284-row file', () => {
  it('imports exactly the counts verified independently against the raw columns', () => {
    const result = parseSplitwiseCsv(REAL_FILE, { members: OUR_TWO });
    expect(result.rowCount).toBe(285); // 284 real rows + the footer
    expect(result.rows).toHaveLength(253); // 225 expenses + 28 settlements
    expect(result.skipped).toHaveLength(32); // 31 zero-net rows + the footer
  });

  it('nets to exactly the file\'s own footer balance for Palle + Kristine', () => {
    // Independent ground truth: the file's OWN "Total balance" row reports
    // kristine sandt = 16.98, Palle Helenius = 360.55. Summing every
    // imported row's amountMinor must equal that combined total to the
    // cent — proof the net-position model reconciles, not just an
    // assertion on the parser's own arithmetic.
    const result = parseSplitwiseCsv(REAL_FILE, { members: OUR_TWO });
    const total = ordinaries(result).reduce((sum, r) => sum + r.amountMinor, 0);
    expect(total).toBe(37753); // $16.98 + $360.55 = $377.53
  });

  it('88 rows have no seeded-category suggestion (28 settlements, always uncategorized by construction, + 60 expenses whose raw label has no confident mapping); 165 expenses map onto a seeded category', () => {
    // providerCategory carries the RAW Splitwise label (settlements aside)
    // — the mapping onto a seeded name is suggestedCategoryName's job, run
    // here exactly as src/routes/imports.ts runs it at import time.
    const result = parseSplitwiseCsv(REAL_FILE, { members: OUR_TWO });
    const suggestions = ordinaries(result).map((r) => suggestedCategoryName(r.providerCategory));
    expect(suggestions.filter((s) => s !== null)).toHaveLength(165);
    expect(suggestions.filter((s) => s === null)).toHaveLength(88);
    // Every settlement row is uncategorized at the source, before mapping is even considered.
    const settlementCount = ordinaries(result).filter((r) => r.providerCategory === null).length;
    expect(settlementCount).toBe(28);
  });
});
