"""Real source regressions: compact units must never become bare numbers."""
import unittest
import pipeline as p

class MoneyRegressionTests(unittest.TestCase):
    def test_indonesian_thousands(self):
        self.assertEqual(p.parse_amount('Rp 75ribu','IDR'),'75000')
        self.assertEqual(p.parse_amount('Rp 349ribu','IDR'),'349000')

    def test_indonesian_decimal_millions(self):
        self.assertEqual(p.parse_amount('Rp 3,499juta','IDR'),'3499000')
        self.assertEqual(p.parse_amount('Rp 1,889juta','IDR'),'1889000')

    def test_unrecognized_magnitudes_fail_closed(self):
        for price,currency in [('Rp 350rb','IDR'),('Rp 3.499juta','IDR'),('Rp 75ribu','USD'),('$20k','USD'),('¥3万','JPY'),('USD 3 million','USD')]:
            with self.subTest(price=price), self.assertRaises(ValueError): p.parse_amount(price,currency)

    def test_entire_affix_is_checked(self):
        for price,currency in [('$19.99 yearly','USD'),('USD 20 per month','USD'),('¥20','USD'),('20','USD'),('USD$20','USD'),('$NaN20','USD'),('R$20','USD')]:
            with self.subTest(price=price), self.assertRaises(ValueError): p.parse_amount(price,currency)

    def test_spaces_do_not_join_arbitrary_digits(self):
        for price in ['$1 2','$19 99',"$1'2",'$1. 999.00']:
            with self.subTest(price=price), self.assertRaises(ValueError): p.parse_amount(price,'USD')
        self.assertEqual(p.parse_amount('4 990,00 Kč','CZK'),'4990')
        self.assertEqual(p.parse_amount('2 495,00 kr','SEK'),'2495')

    def test_source_affixes_and_minor_units(self):
        for text,currency,expected in [('4.999.000đ','VND','4999000'),('99,99 zł','PLN','99.99'),('99,99 lei','RON','99.99'),('9,990.00₸','KZT','9990'),('NT$6,990.00','TWD','6990'),('₦ 31,500.00','NGN','31500'),('S$ 29.98','SGD','29.98'),('Rp 349.000,00','IDR','349000')]:
            with self.subTest(text=text): self.assertEqual(p.parse_amount(text,currency),expected)

if __name__=='__main__': unittest.main()
