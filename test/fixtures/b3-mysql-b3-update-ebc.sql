-- phpMyAdmin SQL Dump
-- version 4.9.7
-- https://www.phpmyadmin.net/
--
-- Host: localhost
-- Generation Time: Jan 22, 2022 at 05:40 PM
-- Server version: 10.3.28-MariaDB
-- PHP Version: 7.4.19

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET AUTOCOMMIT = 0;
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `ebc_b3_pm`
--

-- --------------------------------------------------------

--
-- Table structure for table `player_core`
--

DROP TABLE IF EXISTS `player_core`;
CREATE TABLE `player_core` (
  `id` int(10) UNSIGNED NOT NULL,
  `name` varchar(32) DEFAULT NULL,
  `guid` varchar(32) CHARACTER SET latin1 NOT NULL,
  `status` varchar(32) CHARACTER SET latin1 NOT NULL DEFAULT 'default',
  `style` varchar(32) CHARACTER SET latin1 NOT NULL DEFAULT 'default',
  `winterprestige` int(11) NOT NULL DEFAULT 0,
  `summerprestige` int(11) NOT NULL DEFAULT 0,
  `prestige` int(11) NOT NULL DEFAULT 0,
  `backup_pr` int(11) NOT NULL DEFAULT 0,
  `season` varchar(32) DEFAULT 'null',
  `award_tier` int(11) NOT NULL DEFAULT 0,
  `donation_tier` int(11) NOT NULL DEFAULT 0,
  `donation_date` varchar(16) NOT NULL DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `player_core`
--
ALTER TABLE `player_core`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `id` (`id`),
  ADD KEY `guid` (`guid`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `player_core`
--
ALTER TABLE `player_core`
  MODIFY `id` int(10) UNSIGNED NOT NULL AUTO_INCREMENT;
COMMIT;


-- --------------------------------------------------------

--
-- Table structure for table `prestige_log`
--

DROP TABLE IF EXISTS `prestige_log`;
CREATE TABLE `prestige_log` (
  `id` int(11) NOT NULL,
  `guid` varchar(19) NOT NULL,
  `name` varchar(40) NOT NULL,
  `prestige` int(11) NOT NULL,
  `time` varchar(40) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `prestige_log`
--
ALTER TABLE `prestige_log`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `prestige_log`
--
ALTER TABLE `prestige_log`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
