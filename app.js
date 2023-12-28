const sql = require('mssql')
const { chromium } = require('playwright');
require('dotenv').config()
const express = require('express')
const cron = require('node-cron');
const { EmailClient } = require("@azure/communication-email");
const app = express();
const http = require('http');
const server = http.Server(app);
const port = process.env.PORT || 8888;

const emailClient = new EmailClient(process.env.MAIL_CONNECTION_STRING);

app.use(function(req, res, next) {
    if (req.headers.authorization != process.env.PASSWORD_STRING) {
        res.status(403).json({ error: 'FORBIDDEN' });
    }else{
        next();
    }
});
  
app.get('/', (req, res) => {
    getTrips().then(r => res.status(200).send(r.recordset));
});

//Add
app.post('/', async (req, res) => {
    // make sure that any items are correctly URL encoded in the connection string
    await sql.connect(process.env.CONNECTION_STRING)
    /*const request = new sql.Request()
    request.input('to', sql.VarChar, 'MSP')
    request.input('from', sql.VarChar, 'FRA')
    request.input('departure', sql.Date, '01-07-2024')
    request.input('return', sql.Date, '01-14-2024')
    request.input('price', sql.Decimal, '1000.23')*/
    /*request.query(`insert into Trips 
    (toLocation, fromLocation, departureDate, returnDate, tripStatus, price) values
    (@to, @from, @departure, @return, 0, @price)`

    ,(err, result) => {
        console.dir(result)
        console.dir(err)
    })*/
    getTrips().then(r => res.status(200).send(r));
});

//Remove
//Edit

//Daily check
cron.schedule('* * * * *', async () => {
    console.log("Checking . . .")
    var trips = await getTrips();
    
    console.log(trips);
    //Filter out dates that have passed

    var results = [];

    await Promise.all(trips.map(async trip => {
        var flights = await getFlights(trip);

        results.push(
            ...flights.filter(t => 
                parseFloat(t.price.replace("$", "").replace(",", "")) / 7 < trip.price));
    }));

    if(results.length){
        console.log(`Checking complete, ${results.length} potential flights found.  Sending email . . .`);

        const emailMessage = {
            senderAddress: "DoNotReply@566b52af-1f5a-4736-8532-0f99329e9235.azurecomm.net",
            content: {
                subject: "Wander Watch",
                plainText: JSON.stringify(results),
            },
            recipients: {
                to: [{ address: "karjaxthevaliant@gmail.com" }],
            },
        };
    
        const poller = await emailClient.beginSend(emailMessage);
        await poller.pollUntilDone();
    }else{
        console.log("No results found.")
    }

    
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});

async function getTrips() {
    try {
        await sql.connect(process.env.CONNECTION_STRING)
        return (await sql.query(`select * from Trips`)).recordset
    } catch (err) {
        return err
    }
}

async function getFlights(options){
	var flightInfoList = [];

	const browser = await chromium.launch();
	const page = await browser.newPage();
	try {
		await page.goto('https://www.google.com/travel/flights');
		await page.getByLabel('1 passenger, change number of').click({delay : 100});
		await page.getByLabel('Add adult').click({
		  clickCount: 6,
		  delay : 100
		});
		await page.getByRole('button', { name: 'Done' }).click({delay : 100});
		await page.getByLabel('Where from? Minneapolis').click({delay : 100});
		await page.getByRole('combobox', { name: 'Where else?' }).fill(options.fromLocation);
		await page.getByRole('combobox', { name: 'Where else?' }).press('Enter', {delay : 100});
		await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.type(options.toLocation, {delay : 100})
		await page.getByRole('combobox', { name: 'Where else?' }).press('Enter', {delay : 100});
		await page.keyboard.press('Tab', {delay : 100});
		await page.getByRole('textbox', { name: 'Departure' }).fill(options.departureDate.toString());
		await page.keyboard.press('Tab', {delay : 100});
		await page.getByRole('textbox', { name: 'Return' }).fill(options.returnDate.toString());
		await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.press('Enter', {delay : 1000});
		await page.waitForSelector('.pIav2d');
		
		var flightInfoList = await page.$$eval('.pIav2d', items =>
			items.map(item => ({
				description:item.querySelector('.JMc5Xc').ariaLabel.trim().replace(" Select flight", ""), 
				airline: item.querySelector('.sSHqwe').textContent.trim(),
				travelTime: item.querySelector('.gvkrdb').textContent.trim(),
				price: item.querySelector('.YMlIz.FpEdX').children[0].textContent.trim()
			}))
		);
	} catch (error) {
		console.log(error)
	} finally {
		await browser.close();
	}

	return flightInfoList;
};