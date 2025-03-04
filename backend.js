import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio";


const app = express();
const PORT = 5000;
const url = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?sfId=6bc718a3-598a-4308-b98e-10c829d0730c&isNavigation=true&rows=30&page=1&sort=1&PRICE_TO=12000";

app.use(cors());

const fetchCarAds = async () => {
  try {
    const response = await fetch(url);
    const text = await response.text();
    const $ = cheerio.load(text);
    const cars = [];
    const baseUrl = "https://www.willhaben.at/iad/gebrauchtwagen/d/auto/";

    $("a[data-testid^='search-result-entry-header']").each((i, element) => {
      const id = $(element).attr("id") || $(element).attr("data-testid");
      if (!id) return;

      const extractedId = id.match(/\d+$/)[0];
      const title = $(element).find("h3").text().trim();
      const price = $(element).find("[data-testid^='search-result-entry-price']").text().trim();
      const location = $(element).find("[data-testid^='search-result-entry-location']").text().trim();
      const link = `${baseUrl}${title.toLowerCase().replace(/\s+/g, "-")}-${extractedId}/`;

      cars.push({ id, title, price, location, link });
    });

    console.log(cars)

    return cars;
  } catch (error) {
    console.error("Error fetching car ads:", error);
    return [];
  }
};

app.get("/cars", async (req, res) => {
  const cars = await fetchCarAds();
  res.json(cars);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
